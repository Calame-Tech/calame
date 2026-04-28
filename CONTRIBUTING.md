# Contributing

Thanks for your interest in Calame. This is an early-stage project —
feedback and PRs are welcome.

## Setup

```bash
pnpm install
pnpm dev     # starts at http://localhost:4567
pnpm test    # vitest
pnpm lint    # eslint
pnpm build   # build all packages
```

## PR guidelines

- Run `pnpm test` and `pnpm lint` before pushing
- Keep PRs focused (one feature or fix at a time)
- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`)

## Licensing

Calame is dual-licensed. Where you put a contribution determines its license:

- Code outside `ee/` (root, `packages/*`, `scripts/`, etc.) → **Apache 2.0**.
- Code inside `ee/` → **Business Source License 1.1** (see [`ee/LICENSE.BUSL`](./ee/LICENSE.BUSL) and [`ee/README.md`](./ee/README.md)).

When you submit a PR, you agree that your contribution is licensed under whichever of the two applies to the path(s) you are touching. Every new source file in `ee/` must carry the SPDX header used by existing `ee/` files:

```ts
// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.
```

If you are unsure whether a feature belongs under `ee/` (BUSL) or `packages/` (Apache), open a discussion before writing code — the rule of thumb is that "premium" / enterprise features (SSO, fine-grained RBAC, audit retention, multi-tenant) live in `ee/`, and the open-core engine lives in `packages/`.

## Questions

Open a GitHub Discussion for questions, or an issue for bugs.
