# Code Motion Explainer installation provenance

- Installed skill: `remotion-code-motion-explainer`
- Source repository: `https://github.com/vibe-motion/remotion-code-motion-explainer`
- Project-level path: `.agents/skills/remotion-code-motion-explainer/`
- Upstream `main` at installation: `d93c64393ae4c2a5485a3f8ddf4413c1e6fbe994`
- Installed `SKILL.md` SHA-256: `7ffa799bf318baa13f58b3066cb81684c0a27d5003d6795a31d4f731d700af9c`
- Installer lock hash: `ea261c9e8394dc88572203b3c20306b7aab935831fcd2fdbc0a478bfcb2e1f1c`
- License: MIT, Copyright 2026 Bingo and Vibe Motion contributors

## Verification

The source repository was cloned after installation. Its checked-out HEAD was the
expected commit above, and `diff -qr --exclude=.git` reported no difference between
the checkout and the installed project-level copy.

No shot-library dependencies were installed in the Zhiying root. No showcase or
demo source has been copied into production code. The existing root Remotion package
set remains exactly `4.0.492`.

The installed skill is treated as read-only. Any production adaptation will be a
small Zhiying-owned component that records the selected shot-library entry and the
semantic adaptation, rather than a modification of the installed package.
