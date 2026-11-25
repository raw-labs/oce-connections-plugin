import type {
  ConnectionTemplateVersion,
  PluginDeploymentNetworkRequirement,
  StoredCredentialSource,
} from "@openclaw-enterprise/contracts";
import { ConfigurationHarnessError } from "@openclaw-enterprise/occ";
import { registrations } from "./connections-dev-data.ts";
import type {
  ManagedCliInstall,
  ManagedCredentialSlot,
} from "./managed-catalog.ts";

export interface ConnectionsRegistration {
  packageName: string;
  pluginId: string;
  releaseSha256: string;
  environment: string;
  connector: string;
  host: string;
  authorizationUrl: string;
  scope: string;
  deploymentNetworks: {
    networkOnly: PluginDeploymentNetworkRequirement[];
    credential: PluginDeploymentNetworkRequirement[];
  };
}

export function isConnectionsPlugin(pluginId: string): boolean {
  return registrations.some(
    (registration) => registration.pluginId === pluginId,
  );
}

export const connectionsCliPolicies = registrations.map((registration) => {
  function matchesInstall(install: ManagedCliInstall): boolean {
    return (
      install.id === registration.pluginId &&
      install.releaseSha256 === registration.releaseSha256 &&
      install.credentials.account?.delivery.env === registration.environment &&
      registration.deploymentNetworks.credential.every(
        ({ match }) =>
          match.binary === install.binaryPath &&
          match.host === registration.host,
      )
    );
  }

  return {
    packageName: registration.packageName,
    deploymentNetworks(install: ManagedCliInstall) {
      if (!matchesInstall(install)) {
        throw new ConfigurationHarnessError(
          "The Connections release does not match its registered request policy.",
        );
      }
      return registration.deploymentNetworks;
    },
    accepts(
      install: ManagedCliInstall,
      slot: ManagedCredentialSlot,
      source: StoredCredentialSource,
      template?: ConnectionTemplateVersion,
    ): boolean {
      if (
        !matchesInstall(install) ||
        source.ownerCapability !== "token_service" ||
        source.state !== "ready" ||
        source.type !== "oauth2-refresh-token" ||
        source.consent.kind !== "connection_template" ||
        source.consent.revocationRequestedBy !== undefined ||
        source.consent.revokedAt !== undefined ||
        template?.mode !== "manual"
      ) {
        return false;
      }
      const [destination] = template.destinations;
      return (
        template.templateId === source.connectionTemplateId &&
        template.version === source.consent.version &&
        template.issuer === slot.issuer &&
        template.tokenUrl === slot.tokenEndpoint &&
        template.authorizationUrl === registration.authorizationUrl &&
        template.authorizationParameters.connector === registration.connector &&
        template.scopes.length === 1 &&
        template.scopes[0] === registration.scope &&
        source.consent.grantedScopes.length === 1 &&
        source.consent.grantedScopes[0] === registration.scope &&
        template.destinations.length === 1 &&
        destination?.host === registration.host &&
        destination.port === 443 &&
        destination.path === "/v1/**"
      );
    },
    conflict(
      _source: StoredCredentialSource,
      _sources: readonly StoredCredentialSource[],
    ) {
      // Staged credential deployment checks every binding and rejects overlaps.
      return undefined;
    },
  };
});
