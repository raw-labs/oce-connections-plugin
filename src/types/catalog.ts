export type ConnectorJson =
  | null
  | boolean
  | number
  | string
  | ConnectorJson[]
  | { [key: string]: ConnectorJson };
