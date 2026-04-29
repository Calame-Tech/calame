# Calame Enterprise Edition (`ee/`)

**Everything inside this directory is licensed under the [Business Source License 1.1](./LICENSE.BUSL) — _not_ Apache 2.0.**

The rest of the Calame project (root, `packages/*`, `scripts/`, etc.) is Apache 2.0; the `ee/` subtree is the only part under BUSL.

## What you can do (BUSL Additional Use Grant)

You may freely use, copy, modify, and redistribute the code in `ee/` **as long as you do not use it as part of a Competing Offering** — i.e. a paid product offered to third parties (including paid support) that materially overlaps with Calame.

Non-production use, internal use, self-hosting Calame for your own organization, contributing patches, and forks that are not commercial offerings are all explicitly allowed.

## Change Date

Four years after each version's first publication, that version of `ee/` automatically relicenses to **Apache 2.0** (the BUSL "Change License").

## Need a commercial license?

If your intended use does not fit the Additional Use Grant — e.g. you want to build a competing paid product — contact Calame Tech for a commercial license.

## Contributing to `ee/`

Patches to `ee/` are accepted under the same BUSL terms. Every source file under `ee/` must carry the SPDX header used in [`sso/src/types.ts`](./sso/src/types.ts):

```ts
// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.
```

See the root [`CONTRIBUTING.md`](../CONTRIBUTING.md#licensing) for the full contributor licensing policy.
