# Release credentials

Create a fine-grained PAT as the repository-admin account, with resource owner
`kclejeune`, repository access limited to `nimbus`, and **Contents: read and write**.
Save it as the repository Actions secret `RELEASE_TOKEN`:

```sh
gh secret set RELEASE_TOKEN --repo kclejeune/nimbus
```

The command prompts for the token without displaying it. Alternatively, use
[Actions secrets](https://github.com/kclejeune/nimbus/settings/secrets/actions).
Choose an expiration and replace the secret before it expires.

The main ruleset's existing repository-admin bypass covers this PAT. Do not add
the write role to the bypass list. The token's Contents permission authorizes Git
writes; the account's admin role supplies the bypass. `GITHUB_TOKEN` cannot
substitute for it: it lacks the bypass, and its tag pushes do not start release
CI. See [GitHub's workflow triggering documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

## Partial release recovery

After the updated workflow is on main and the secret is configured, the Release
tag workflow can be run manually:

```sh
gh workflow run release-tag.yml --repo kclejeune/nimbus --ref main
```

An existing tag is preserved and checked against the release history. The
workflow resumes the development bump on current main only if VERSION still
matches that release. Retrying an old workflow run uses its old workflow code;
use the manual trigger to run the updated code.

Resuming the bump does not publish a missing release or retrigger CI for an
existing tag. In particular, the failed August 31, 2026 run created `v0.6.0`
using `GITHUB_TOKEN`, so that tag has no associated release CI run. Publishing
that historical version needs a separate recovery; do not delete or move its
tag as part of credential setup.
