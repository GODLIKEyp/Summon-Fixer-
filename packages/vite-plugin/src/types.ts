export interface SummonFixerPluginOptions {
  /**
   * Localhost engine URL.
   * Can be configured via SUMMON_ENGINE_URL environment variable or option.
   * Defaults to 'http://127.0.0.1:3883'.
   */
  engineUrl?: string;

  /**
   * Engine secret authentication token.
   * Can be configured via SUMMON_ENGINE_TOKEN environment variable.
   * Never exposed to the browser client.
   */
  engineToken?: string;

  /**
   * Root path prefix for Summon Fixer API endpoints.
   * Defaults to '/__summon/v1'.
   */
  apiPrefix?: string;

  /**
   * Whether to enable automatic JSX source instrumentation in dev mode.
   * Defaults to true.
   */
  instrumentJsx?: boolean;
}

export interface VerifiedSourceMapping {
  sourceId: string;
  file: string;
  line: number;
  column: number;
  revision?: string;
  elementTag?: string;
}
