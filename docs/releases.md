# Releases

`VERSION` on main carries a `-dev` suffix between releases. To release:

1. Open a PR that drops the suffix (`0.7.2-dev` → `0.7.2`). `release-guard.yml`
   checks the version against the cycle's conventional commits (`feat` →
   minor, `fix`/`perf`/`refactor` → patch, `!` or `BREAKING CHANGE` → major)
   and fails if the proposed version is lower or already tagged. It is not a
   required check, so an intentional override is a visible merge past it.
2. Merge it. `release-tag.yml` tags the merge commit `v<VERSION>`, and the tag
   push starts `ci.yml`, which publishes the release with GoReleaser.
3. The same job commits the next patch version with `-dev` to main.

A release publishes CLI binaries only. The Worker and D1 migrations deploy
separately (`docs/deploy.md`); when a release changes the wire protocol, add
an upgrade note there.

## Credentials

`release-tag.yml` needs a fine-grained PAT in the Actions secret
`RELEASE_TOKEN`, for two reasons: tags pushed with `GITHUB_TOKEN` do not
trigger workflows, and the reopen commit to main needs the ruleset's
repository-admin bypass, which `GITHUB_TOKEN` lacks
([GitHub docs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)).

Create it as the repository-admin account: resource owner `kclejeune`,
repository access limited to `nimbus`, **Contents: read and write**, with an
expiration. Then:

```sh
gh secret set RELEASE_TOKEN --repo kclejeune/nimbus   # prompts without echoing
```

The admin role supplies the bypass; don't add the write role to the bypass
list. Replace the secret before it expires.

## Recovering a partial release

If a run fails after tagging, start a new run from current main. Don't use
"re-run" on the failed run, which replays that run's workflow code:

```sh
gh workflow run release-tag.yml --repo kclejeune/nimbus --ref main
```

An existing tag is kept and checked against history, and the `-dev` bump is
resumed only if `VERSION` still names that release. This does not publish a
missing release or re-trigger CI for an existing tag. Never delete or move a
published tag.

`v0.6.0` is the one tag that never got release CI: it was pushed with
`GITHUB_TOKEN` on 2026-08-31. The release was backfilled on 2026-09-07
from GoReleaser artifacts built and tested at the tagged commit; the tag was
left in place.
