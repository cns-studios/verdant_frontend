# Verdant Desktop

If you want to contribute, please visit `BUGS.md` to resolve pending Bugs. Feature Requests are in `FEATURE_REQ.md`, but have lower priority than Bugs.

## ToDo's

- [ ] CI Pipeline (GH Actions)
- [ ] Other SMTP Support (Currently Gmail only)
- [ ] Performance testing

## Release Workflows

- Push to `main` runs `.github/workflows/nightly-main.yml`.
- That workflow builds Linux bundles (`.deb`, `.rpm`, `.AppImage`, Arch `.pkg.tar.zst`) and a Windows NSIS installer.
- The build is published as a GitHub prerelease (nightly channel).

Stable channel releases are promoted manually through `.github/workflows/promote-stable.yml` using `workflow_dispatch`.