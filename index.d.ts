import type {LRUCache} from 'lru-cache';

export default class Hubkit {
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
  /** Successful response representation. HTTP errors (status >= 400) use JSON or text instead. */
  responseType?: 'text' | 'arraybuffer' | 'blob';
  maxTries?: number;
  timeout?: number;
  maxItemSizeRatio?: number;
  metadata?: Metadata;
  stats?: Stats;
  cache?: LRUCache<
    string,
    {promise: Promise<any>, size: number} |
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
  onSend?(cause: 'initial' | 'retry' | 'page'): number | Promise<number>;  // returns timeout
  onReceive?(call?: {api: 'core' | 'graph' | 'search', cost: number | undefined}): void;
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
  searchRateLimit?: number;
  searchRateLimitRemaining?: number;
  graphRateLimit?: number;
  graphRateLimitRemaining?: number;
  oAuthScopes?: string[];
  contentType?: string;
}
