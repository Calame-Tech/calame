# Calame `ee/` — source-available modules

**Everything inside this directory is licensed under the [Business Source License 1.1](./LICENSE.BUSL) — _not_ Apache 2.0.**

The rest of the Calame project (root, `packages/*`, `scripts/`, etc.) is Apache 2.0; the `ee/` subtree is the only part under BUSL.

## What you can do — and when you need a license

You may freely use, copy, modify, and redistribute the code in `ee/` **for non-production purposes**: development, testing, evaluation, demonstration, training, internal experimentation, CI, and security research. Contributing patches and non-commercial forks are also fine.

**Running `ee/` features in production requires a paid commercial license — Calame Pro (flat per-instance).** For specific needs (custom SLA, federated SSO, deployment on sensitive infrastructure, etc.), [contact us](#need-a-commercial-license) for a tailored arrangement. Production use means serving real end-users, processing production business data, or otherwise supporting live operations — yours or a third party's. Spinning up an instance to evaluate the SSO module against a test directory is fine; pointing it at your real workforce is not.

Even for non-production use, you may not use the code in `ee/` to build or operate a **Competing Offering** — a paid product (including paid support) that materially overlaps with Calame.

## Change Date

Four years after each version's first publication, that version of `ee/` automatically relicenses to **Apache 2.0** (the BUSL "Change License").

## Need a commercial license?

If your intended use does not fit the Additional Use Grant — e.g. you want to build a competing paid product — contact Calame Tech inc. for a commercial license.

## Contributing to `ee/`

Patches to `ee/` are accepted under the same BUSL terms. Every source file under `ee/` must carry the SPDX header used in [`sso/src/types.ts`](./sso/src/types.ts):

```ts
// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.
```

See the root [`CONTRIBUTING.md`](../CONTRIBUTING.md#licensing) for the full contributor licensing policy.
