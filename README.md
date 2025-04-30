hubkit
======

[![Project Status: Active - The project has reached a stable, usable state and is being actively developed.](http://www.repostatus.org/badges/latest/active.svg)](http://www.repostatus.org/#active)

A simple GitHub API library for JavaScript that works in both NodeJS and the browser.  Features:
* Takes a request-level approach that naturally covers the entire GitHub v3 API.
* Supports the GraphQL v4 API.
* All requests return promises.  (You may need to add a polyfill in the browser, depending on your target platforms.)
* Responses are (optionally) cached (segregated by user identity), and requests are conditional to save on bandwidth and request quota.
Inspired by [simple-github](https://github.com/tobie/simple-github), [octo](https://github.com/Caged/octo), and [octokit](https://github.com/philschatz/octokit.js).

#### Integration and dependencies

You need to ensure that an ES2015-compatible `Promise` class is defined.

To enable caching, make sure that [LRUCache](https://github.com/isaacs/node-lru-cache) is
loaded. It's installed by default for Node, but in the browser you need to load `lru-cache.js`
(perhaps from the [Bower-compatible variant](https://github.com/jmendiara/serialized-lru-cache)).  Or
you can pass any other cache instance as an option to the constructor, as long as it has `get`,
`set`, and `del` methods.  If the cache is enabled Hubkit respects `Cache-Control` headers on the response (that GitHub currently seems to set to 1 minute for all requests), and will return a potentially stale value from the cache unless you specify `{fresh: true}`.

If you're fetching Hubkit via Bower, note that the `superagent` dependency _does not ship with browser-ready code_.  You'll need to make a dist build yourself via Browserify.  Ironically, the `npm` package for `superagent` does include browser-ready code.

#### Usage

A simple REST example:

```javascript
var gh = new Hubkit({
  token: '123456890ABCDEF',
  owner: 'pkaminski',
  repo: 'hubkit'
});
gh.request('GET /repos/:owner/:repo/commits').then(console.log);
gh.request('GET /repos/:owner/:repo/git/commits/:sha', {sha: '09876abc'}).then(console.log);
gh.request('POST /repose/{owner}/{repo}/pulls', {body: {title: 'foo', head: 'bar', base: 'master'}});
```

And one for GraphQL:

```javascript
// initialize gh as above
gh.graph(`
  query ($after: String) {
    search (type: ISSUE, first: 10, after: $after, query: `type: pr`) {
      pageInfo {hasNextPage, endCursor},
      nodes {
        ... on PullRequest {
          number, title
        }
      }
    }
  }
`);
```

You issue requests exactly as documented in GitHub's [REST API](https://developer.github.com/v3/) or
[GraphQL API](https://developer.github.com/v4/).  For REST, path segments of the form `:foo` or
`{foo}` are interpolated from the options object passed as the second argument and defaulting to the
options object passed to the constructor.  The method can be specified either together with the path,
or as a `{method: 'GET'}` option (the inline one takes precedence, and `GET` is the default if
nothing else is found).

GraphQL queries are first run through a preprocessor that supports the following directives:

* `#ghe(minVersion)`: The following block is excluded if the GHE version is too old.
* `#scope(scope)`: The following block is excluded if the user's authorization lacks the specified scope.
* `#field(type, ...fields)`: If followed by a block, the block is excluded if the given field(s) don't exist in the schema. If the block is omitted, the directive gets substituted with the first given field that exists in the schema for the given type.

This is useful since GraphQL forbids references to fields not in the schema, and GHE servers in the field are often months or years behind `github.com` in that respect.  To use the `ghe` or `scope` directives you need to include the `gheVersion` or `scopes` properties respectively in the options (see below). Here is an example demonstrating each directive:

```javascript
gh.graph(`
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository (owner: $owner, name: $repo) {
      pullRequest (number: $number) {
        id, number, title,
        #ghe(2.17) {
          isDraft
        #}
        #field(PullRequest, mergeQueueEntry) {
          mergeQueueEntry {
            headCommit {oid}
          }
        #}
        reviewRequests {
          nodes {
            requestedReviewer {
              ...on User {
                login, name,
                id: #field(User, fullDatabaseId, databaseId)
              }
              #scope(read:org) {
                ...on Team {combinedSlug, name}
              #}
            }
          }
        }
      }
    }
  }
`);
```

There are two ways to authenticate:  either pass a `token` to the options, or both a `clientId` and
`clientSecret`.  Unauthenticated requests are fine too, of course.

Every call returns a `Promise`.  The returned values are exactly as documented in the GitHub API,
except that requests with option `{boolean: true}` will return `true` or `false` instead (sorry, no
way to automate it).  Note that for paged responses, all pages will be concatenated together into
the return value by default (see below).

After every request, you can access `rateLimit` and `rateLimitRemaining` (or `searchRateLimit` and
`searchRateLimitRemaining` if it's a search request, or `graphRateLimit` and
`graphRateLimitRemaining` if it's a GraphQL query) for the latest information on your GitHub
quotas, and `oAuthScopes` to see what scopes your authorization entitles you to, on your `metadata`
object (see below) or on `Hubkit` if you didn't set one.

You can augment a Hubkit instance by calling `gh.scope({...moreOptions})` to return a new instance that combines both sets of options.

#### Options reference

Valid options to pass (to the constructor or to each request), or to set on `Hubkit.defaults`,
include:
* `token`: String token to use for authentication; takes precedence over other auth methods.
* `clientId` and `clientSecret`: For app-based anonymous authentication (increased API quotas without impersonating a user).
* `userAgent`: The user-agent to present in requests.  Uses the browser's user agent, or `Hubkit`
in NodeJS.
* `host`: The URL to prepend to all request paths; defaults to `https://api.github.com`.
* `graphHost`: The URL to use for all GraphQL requests; defaults to using the value of `host` which works fine for `github.com`, but you'll need to set a separate value when working with GitHub Enterprise.
* `timeout`: The timeout in milliseconds to apply to the request; none by default.  If the timeout is reached, the request will abort with an error that will have a `timeout` attribute set to the value you provided.
* `agent`: On NodeJS only, the agent to use for the HTTP connection, e.g. to do connection pooling.  You may want to consider using [agentkeepalive](https://www.npmjs.com/package/agentkeepalive) if you're making a lot of requests.
* `cache`: An object with `get`, `set`, and `del` methods to be used as a cache for responses.  The
objects inserted into the cache will be of the form
`{value: {...}, eTag: 'abc123', status: 200, size: 1763}`.
You can use the (approximate) `size` field to help your cache determine when to evict items, but note that it tends to underestimate the actual size size of the object by 3-4x.  The
default cache is set to hold ~10MB of the measured bytes amount (so ~30-40MB of actual memory usage).
* `fresh`: If true, force a request to be issued to the server even if a cache is in use and an unexpired value available.  This is different from turning off the cache for the request since it can still make use of ETags and get a cheap 304 response in return.
* `maxItemSizeRatio`: The maximum ratio of the size of any single item to the size of the cache, to avoid blowing away the entire cache with one huge item.  The default is set to 0.1, limiting each item to at most 1/10th the max size of the cache.
* `stats`: Reports the cache hit rate via `hitRate` (number of items hit / total attempted) and `hitSizeRate` (total size of items hit / total attempted) attributes.  You can `reset()` the stats to start counting from scratch again.  A default instance is set on `Hubkit.defaults` but you can also assign a `new Hubkit.Stats()` to a `Hubkit` instance if you prefer.
* `immutable`: If true, indicates that the return value for this call is immutable, so if it's available in the cache it can be reused without sending a request to GitHub to check freshness.
* `stale`: If true, any cached value is considered acceptable, even if it has expired.
* `method`: The HTTP method to use for the request.
* `media`: A GitHub-specific [media type](https://developer.github.com/v3/media/) for the response
content.  Valid values are:
  * for comment bodies: `raw+json` (default), `text+json`, `html+json`, `full+json`
  * for blobs: `json` (default), `raw`
  * for commits, etc.: `diff`, `patch`
* `body`: The contents of the request to send, typically a JSON-friendly object.
* `variables`: For GraphQL queries, variables to pass to the server along with the query.
* `responseType`: The XHR2 response type if you want to receive raw binary data; one of `text`, `arraybuffer`, `blob`, or `document`.  Only useful when fetching file blobs.
* `perPage`: The number of items to return per page of response.  Defaults to 100.
* `allPages`: Whether to automatically fetch all pages by following the `next` links and concatenate
the results before returning them.  Defaults to true.  If set to false and a result has more pages,
you'll find a `next()` function on the result that you can call to get a promise with the next page
of items.  This also works for GraphQL queries, as long as your query has a `$after: String` parameter defined, and the results have a single top-level key with `pageInfo {hasNextPage, endCursor}` and `nodes` children.
* `boolean`: If true, interprets a 404 as false and a 20x as true.
* `metadata`: The object on which to set metadata found in the response headers.  Defaults to `Hubkit`.
* `ifNotFound`: A value to return instead of throwing an exception when the request results in a 404.
* `ifGone`: A value to return instead of throwing an exception when the request results in a 410.
* `onError`: A function to be called when an error occurs, either in the request itself or an
unexpected 4xx or 5xx response.  If it's an error response, the error object will have `status`,
`method`, `path`, and `response` attributes.  If the function returns `undefined`, the promise will
be rejected as usual (or the request retried in some special cases, like socket hang ups and abuse quota 403s), if it returns `Hubkit.RETRY` the request will be retried, if it returns `Hubkit.DONT_RETRY` the promise will always be rejected, and if returns any other value the promise will be resolved with the returned value.  If multiple onError handlers are assigned (e.g., in default options and in per-request options), they will all be executed, and the first non-undefined value from the most specific handler will be used.
* `maxTries`: The maximum number of times that a request will be tried (including the original call) if `onError` keeps returning `Hubkit.RETRY`.
* `onSend`: A function to be called before every individual request gets sent to GitHub.  The sole argument will be a string indicating the reason for the request: `initial` for the initial request, `page` for an automatic next page request (if the `allPages` option is on), and `retry` for an explicit or automatic retry.  The function can return a duration in milliseconds that will override the timeout provided in the options (if any).  The function can also return a promise for the above, in which case the request will be held until the promise is resolved.
* `gheVersion`: A string representing the version of the GitHub Enterprise server you're making calls to.  You can retrieve it via a request to `/meta`.  Ignored if your host is `https://api.github.com` (and all `#ghe` preprocessing directives pass automatically).  Otherwise, if a `#ghe` directive is encountered and `gheVersion` is not set then an error is thrown.
* `scopes`: An array of strings representing all the scopes granted to the user's token.  (Note that some scopes imply others, but Hubkit doesn't expand these internally &mdash; you might want to do so yourself.)  If a `#scope` directive is encountered and `scopes` is not set then an error is thrown.
