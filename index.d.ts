import type {LRUCache} from 'lru-cache';

export default Hubkit;

type Hubkit = HubkitClass;
declare const Hubkit: typeof HubkitClass & Metadata;

declare class HubkitClass {
  static defaults: Options & {stats: Stats};
  static Stats: StatsClass;
  static readonly RETRY: unique symbol;
  static readonly DONT_RETRY: unique symbol;
  static identify403Error(error: string | {message: string}): Identified403Error | undefined;

  constructor(options?: Options);
  defaultOptions: Options;
  request(path: string, options?: Options): Promise<any>;
  graph(query: string, options?: Options & {variables?: Record<string, any>}): Promise<any>;
  interpolate(string: string, options?: Record<string, any>): string;
  scope(options: Options): Hubkit;
}

export type Identified403Error = ({
  code: 'account-suspended' | 'email-unverified' | 'saml-enforcement' | 'admin-required' |
    'two-factor-required';
  category: 'badauth';
} | {
  code: 'oauth-app-restrictions';
  category: 'thirdparty';
} | {
  code: 'ip-allow-list';
  category: 'iprestricted';
} | {
  code: 'access-blocked';
  category: 'notfound';
}) & {error: string; quota?: never} | {
  code: 'secondary-rate-limit' | 'rate-limit';
  quota: true;
  category?: never;
  error?: never;
};

type OnSendResult = number | null | void;

interface Options {
  method?: string;
  host?: string;
  graphHost?: string;
  pathPattern?: string;
  body?: any;
  /** Override automatic retry inference for REST or GraphQL; onError takes precedence. */
  idempotent?: boolean;
  media?: string;
  ifNotFound?: any;
  ifGone?: any;
  perPage?: number;
  allPages?: boolean;
  boolean?: boolean;
  immutable?: boolean;
  fresh?: boolean;
  stale?: boolean;
  /** Successful response representation. Treat shared buffers as read-only; copy before mutation
   * or transfer. HTTP errors (status >= 400) use JSON or text instead. */
  responseType?: 'text' | 'arraybuffer' | 'blob';
  maxTries?: number;
  timeout?: number;  // zero invokes onError immediately without sending the request
  maxItemSizeRatio?: number;
  metadata?: Metadata;
  stats?: Stats;
  cache?: LRUCache<
    string,
    {pending: number, size: number} |
    {value: any, eTag?: string, status: number, headers: any, size: number, expiry?: number}
  > | null;
  userAgent?: string;
  autoQueryRateLimit?: boolean;

  token?: string;
  clientId?: string;
  clientSecret?: string;
  apiVersion?: string;

  [key: string]: any;

  onRequest?(options: Options): void | Promise<void>;  // can mutate options
  // Returns a timeout; zero invokes onError immediately, nullish results retain the options timeout.
  onSend?(cause: 'initial' | 'retry' | 'page'): OnSendResult | Promise<OnSendResult>;
  onReceive?(call?: {api: 'core' | 'graph' | 'search', cost: number | undefined}, shared?: boolean): void;
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
    networkFailure?: boolean,
    /** Computed rate-limit retry delay in milliseconds. */
    retryDelay?: number,
  }):
    undefined | typeof Hubkit.RETRY | typeof Hubkit.DONT_RETRY | any;
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

export interface Metadata {
  rateLimit?: number;
  rateLimitRemaining?: number;
  /** Quota reset time in milliseconds since the Unix epoch. */
  rateLimitResetTimestamp?: number;
  /** Time the quota headers were observed, in milliseconds since the Unix epoch. */
  rateLimitTimestamp?: number;
  searchRateLimit?: number;
  searchRateLimitRemaining?: number;
  searchRateLimitResetTimestamp?: number;
  searchRateLimitTimestamp?: number;
  graphRateLimit?: number;
  graphRateLimitRemaining?: number;
  graphRateLimitResetTimestamp?: number;
  graphRateLimitTimestamp?: number;
  oAuthScopes?: string[];
  contentType?: string;
}
