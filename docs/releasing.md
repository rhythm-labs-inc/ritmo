# Release Ritmo

Rhythm Labs Inc. maintains the `@rhythm-labs-inc/ritmo` package and the [public repository](https://github.com/rhythm-labs-inc/ritmo).

**Current status — September 22, 2026:** `0.2.0-rc.1` is in preparation. The public repository exists with Issues and private vulnerability reporting enabled, but it has no source commits or releases yet. The npm package is unpublished. Update this status when publication is complete.

## Prerequisites

**Review access and release contents**

Confirm the release owners have GitHub and npm access, recovery options, and two-factor authentication. Check branch/release protections and workflow permissions. Keep access and recovery details in the organization settings.

Publish only the reviewed public source tree. Review [LICENSE](../LICENSE), [NOTICE](../NOTICE), the [changelog](../CHANGELOG.md), and the version before creating the release.

**Complete acceptance for the release candidate**

The recorded acceptance covers Lenny's Data bearer/OAuth flows, GitHub registered-client OAuth resource reads and CLI validation, and local widget controls. Preserve that evidence and rerun affected checks when related code changes. Check any remaining release criteria against the exact packaged version. Record known limitations explicitly.

Review dependency advisories and changes in the [host contract sources](apps-sdk-contract.md), including differences between Ritmo's current checks and the submission portal.

## Rehearsal

**Verify a clean checkout**

```bash
npm ci
npm run ci:quality
npm pack --json
```

Keep the source commit, lockfile, source manifest, release manifest, test results, installed-consumer report, and tarball integrity together. Compare the final tarball with the verified package before publishing.

**Publish the approved version**

Get release-owner approval for the exact version and contents. Use an immutable version tag, such as `v0.2.0-rc.1`, and the npm `next` tag for a prerelease. Do not overwrite published versions or move published tags.

Publish release notes with installation instructions, known limitations, and migration guidance. Check that source, package, issue links, and CI results are accessible. Update the release-status wording in the docs after publication.

## Downstream compatibility

If another application imports Ritmo, test its integration against the exact tarball before updating its lockfile. Verify connection behaviour, authentication, exported API calls, and errors. Keep shared fixes in Ritmo and consume them through a versioned package.

## Upgrade and rollback

Pin versions when importing the library. Read the changelog and [migration guide](migration.md) before updating older configurations or credentials.

To roll back, reinstall the previous package version or tarball and restore the matching lockfile. Older executables cannot read credentials saved only under the new `ritmo` keychain service; they may need a fresh login. Keep project backups before renaming configuration or state directories.

For a faulty published release, prefer a corrected version and an appropriate npm tag update. Preserve the original release history.
