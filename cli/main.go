package main

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

const usage = `Usage:
  oce-connections [--slot NAME] actions [--query TEXT] [--cursor N] [--limit N]
  oce-connections [--slot NAME] describe ACTION
  oce-connections [--slot NAME] run ACTION --version VERSION [--request-id UUID] < arguments.json
  oce-connections [--slot NAME] receipt REQUEST_ID [--cursor N]
`

const maxRequest = 128 * 1024
const maxResponse = 9 * 1024 * 1024

var (
	slotName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,23}$`)
	actionID = regexp.MustCompile(`^[A-Z][A-Z0-9_]{1,255}$`)
	uuid     = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	bearer   = regexp.MustCompile(`^[!-~]+$`)
)

type command struct {
	method    string
	path      string
	query     url.Values
	body      []byte
	requestID string
}

type invocation struct {
	ActionID  string          `json:"actionId"`
	Version   string          `json:"version"`
	RequestID string          `json:"requestId"`
	Arguments json.RawMessage `json:"arguments"`
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 || (len(args) == 1 && (args[0] == "--help" || args[0] == "help")) {
		fmt.Fprint(stdout, usage)
		return 0
	}
	global := flags("oce-connections")
	slot := global.String("slot", "", "")
	if global.Parse(args) != nil || (*slot != "" && !slotName.MatchString(*slot)) {
		fmt.Fprint(stderr, usage)
		return 2
	}
	request, err := parseCommand(global.Args(), stdin)
	if err != nil {
		fmt.Fprintln(stderr, err)
		fmt.Fprint(stderr, usage)
		return 2
	}
	data, err := send(*slot, request)
	if err != nil {
		fmt.Fprintln(stderr, err)
		if request.requestID != "" {
			fmt.Fprintln(stderr, "Inspect this request with receipt:", request.requestID)
		}
		return 1
	}
	if _, err := fmt.Fprintln(stdout, string(data)); err != nil {
		return 1
	}
	if request.requestID != "" {
		var result struct {
			Status string `json:"status"`
		}
		if json.Unmarshal(data, &result) != nil || result.Status != "succeeded" {
			return 1
		}
	}
	return 0
}

func flags(name string) *flag.FlagSet {
	set := flag.NewFlagSet(name, flag.ContinueOnError)
	set.SetOutput(io.Discard)
	return set
}

func parseCommand(args []string, stdin io.Reader) (command, error) {
	invalid := errors.New("Invalid command or arguments.")
	if len(args) == 0 {
		return command{}, invalid
	}
	switch args[0] {
	case "actions":
		options := flags("actions")
		query := options.String("query", "", "")
		cursor := options.String("cursor", "", "")
		limit := options.Int("limit", 10, "")
		if options.Parse(args[1:]) != nil || options.NArg() != 0 || *limit < 1 || *limit > 25 {
			return command{}, invalid
		}
		params := url.Values{"limit": {fmt.Sprint(*limit)}}
		if *query != "" {
			params.Set("q", *query)
		}
		if *cursor != "" {
			params.Set("cursor", *cursor)
		}
		return command{method: http.MethodGet, path: "/v1/actions", query: params}, nil
	case "describe":
		if len(args) != 2 || !actionID.MatchString(args[1]) {
			return command{}, invalid
		}
		return command{method: http.MethodGet, path: "/v1/action", query: url.Values{"id": {args[1]}}}, nil
	case "receipt":
		if len(args) < 2 || !uuid.MatchString(args[1]) {
			return command{}, invalid
		}
		options := flags("receipt")
		cursor := options.String("cursor", "", "")
		if options.Parse(args[2:]) != nil || options.NArg() != 0 {
			return command{}, invalid
		}
		params := url.Values{"requestId": {strings.ToLower(args[1])}}
		if *cursor != "" {
			params.Set("cursor", *cursor)
		}
		return command{method: http.MethodGet, path: "/v1/calls", query: params}, nil
	case "run":
		if len(args) < 2 || !actionID.MatchString(args[1]) {
			return command{}, invalid
		}
		options := flags("run")
		version := options.String("version", "", "")
		requestID := options.String("request-id", "", "")
		if options.Parse(args[2:]) != nil || options.NArg() != 0 ||
			*version == "" || *version == "latest" || len(*version) > 200 ||
			(*requestID != "" && !uuid.MatchString(*requestID)) {
			return command{}, invalid
		}
		if *requestID == "" {
			*requestID = newRequestID()
		}
		raw, err := io.ReadAll(io.LimitReader(stdin, maxRequest+1))
		raw = bytes.TrimSpace(raw)
		if err != nil || len(raw) == 0 || len(raw) > maxRequest || raw[0] != '{' || !json.Valid(raw) {
			return command{}, errors.New("Provide a bounded JSON object on standard input.")
		}
		payload, err := json.Marshal(invocation{args[1], *version, strings.ToLower(*requestID), raw})
		if err != nil || len(payload) > maxRequest {
			return command{}, errors.New("Invocation exceeds the request size limit.")
		}
		return command{method: http.MethodPost, path: "/v1/calls", body: payload, requestID: strings.ToLower(*requestID)}, nil
	default:
		return command{}, invalid
	}
}

func newRequestID() string {
	var value [16]byte
	rand.Read(value[:])
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[:4], value[4:6], value[6:8], value[8:10], value[10:])
}

func send(slot string, command command) ([]byte, error) {
	prefix := "OCE_CONNECTIONS_"
	if slot != "" {
		prefix += strings.ToUpper(strings.ReplaceAll(slot, "-", "_")) + "_"
	}
	origin, err := url.Parse(os.Getenv(prefix + "URL"))
	if err != nil || origin.Scheme != "https" || origin.Hostname() == "" || origin.User != nil ||
		(origin.Path != "" && origin.Path != "/") || origin.RawPath != "" || origin.RawQuery != "" ||
		origin.ForceQuery || origin.Fragment != "" || origin.Opaque != "" {
		return nil, errors.New("Connections requires a credential-free HTTPS origin for this slot.")
	}
	token := os.Getenv(prefix + "TOKEN")
	if len(token) > 2048 || !bearer.MatchString(token) {
		return nil, errors.New("No Connections credential is available for this slot.")
	}
	origin.Path = command.path
	origin.RawQuery = command.query.Encode()
	var content io.Reader
	if len(command.body) != 0 {
		content = bytes.NewReader(command.body)
	}
	request, err := http.NewRequest(command.method, origin.String(), content)
	if err != nil {
		return nil, errors.New("Could not construct the Connections request.")
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "oce-connections")
	if len(command.body) != 0 {
		request.Header.Set("Content-Type", "application/json")
	}

	transport := &http.Transport{
		Proxy:           http.ProxyFromEnvironment,
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
	}
	if path := os.Getenv("OCE_CONNECTIONS_CA_FILE"); path != "" {
		cert, readErr := os.ReadFile(path)
		roots, poolErr := x509.SystemCertPool()
		if readErr != nil || poolErr != nil || !roots.AppendCertsFromPEM(cert) {
			return nil, errors.New("Could not load the additional Connections CA.")
		}
		transport.TLSClientConfig.RootCAs = roots
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		Timeout:   75 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("Connections HTTPS request failed.")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
		var problem struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &problem) == nil && knownError(problem.Error) {
			return nil, fmt.Errorf("Connections returned HTTP %d (%s).", response.StatusCode, problem.Error)
		}
		return nil, fmt.Errorf("Connections returned HTTP %d.", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponse+1))
	if err != nil || len(data) > maxResponse || !json.Valid(data) {
		return nil, errors.New("Connections returned an unreadable response.")
	}
	escapedToken, _ := json.Marshal(token)
	if bytes.Contains(data, []byte(token)) || bytes.Contains(data, escapedToken[1:len(escapedToken)-1]) {
		return nil, errors.New("Connections returned an unreadable response.")
	}
	return data, nil
}

func knownError(code string) bool {
	switch code {
	case "invalid_request", "invalid_arguments", "invalid_token", "action_unavailable",
		"action_version_changed", "account_unavailable", "receipt_unavailable",
		"request_id_conflict", "invalid_result_cursor", "request_too_large",
		"provider_unavailable", "server_error":
		return true
	default:
		return false
	}
}
