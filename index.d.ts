export default class Hubkit<TParams extends Parameters = {}> {
  static defaults: Options & {stats: Stats};
  static Stats: StatsClass;
  static readonly RETRY: unique symbol;
  static readonly DONT_RETRY: unique symbol;

  constructor(options?: Options & TParams);
  defaultOptions: Options & TParams;
  request(path: string, options?: Options & Parameters): Promise<any>;
  graph(query: string, options?: Options & {variables?: Record<string, any>}): Promise<any>;
  interpolate(string: string, options?: Parameters);
  scope<Tsource extends Parameters>(options: Options & Tsource): Hubkit<TParams & Tsource>;
}

interface Options {
  method?: string;
  host?: string;
  graphHost?: string;
  pathPattern?: string;
  body?: any;
  media?: string;
  ifNotFound?: any;
  ifGone?: any;
  perPage?: number;
  allPages?: boolean;
  boolean?: boolean;
  immutable?: boolean;
  fresh?: boolean;
  stale?: boolean;
  responseType?: string;
  maxTries?: number;
  timeout?: number;
  maxItemSizeRatio?: number;
  metadata?: Metadata;
  stats?: Stats;
  agent?: any;
  corsSuccessFlags?: Record<string, boolean>;
  cache?: any;
  userAgent?: string;

  token?: string;
  clientId?: string;
  clientSecret?: string;
  apiVersion?: string;

  onSend?(cause: 'initial' | 'retry' | 'page'): number;  // returns timeout
  onError?(error: Error & {
    status?: number,
    data?: any,
    errors?: any,
    method?: string,
    path?: string,
    request?: any,
    response?: any,
    logTag?: string,
    fingerprint?: string[],
    timeout?: boolean,
  }):
    undefined | typeof Hubkit.RETRY | typeof Hubkit.DONT_RETRY | any;
}

interface Parameters {
  [key: string]: any;
}

interface StatsClass {
  new(): Stats;
}

interface Stats {
  reset(): void;
  record(isHit: boolean, size: number): void;
  hitRate: number;
  hitSizeRate: number;
}

interface Metadata {
  rateLimit?: number;
  rateLimitRemaining?: number;
  searchRateLimit?: number;
  searchRateLimitRemaining?: number;
  graphRateLimit?: number;
  graphRateLimitRemaining?: number;
  oAuthScopes?: string[];
}
