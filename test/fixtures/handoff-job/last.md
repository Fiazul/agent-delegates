WORKER FAILED: API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 10h0m0s.

Ran the failing test once, reproduced locally, started editing lib/console.js retry loop before quota hit.
