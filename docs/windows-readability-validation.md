# Validating readability on the Windows desktop app

Manual checklist for the readability changes made after the first
non-developer tester's feedback (point 03: text too small, contrast too low)
on the Sources → knowledge base → MCP screens. The tester's build was probably
0.8.3 or 0.8.4 — this is unconfirmed. The repository is at 0.8.4
(`package.json`).

## What changed

- Secondary text on these screens moved from `text-gray-500`/`text-gray-600`
  (3.8:1 / 2.4:1 on cards) to `text-gray-400` (at least 4.5:1, WCAG AA).
- Badges and pills moved from 9–10px to 11px; the shared `.eyebrow` section
  labels (`packages/web/src/index.css`) are 11px gray-400.
- Field labels that sit above a hint (MCP response mode, document write,
  authentication) use `text-gray-300` so they stay distinct from their
  `text-gray-400` hint.
- Input placeholders use `placeholder-gray-500` (was `gray-600`): WCAG does
  not require contrast for placeholders, and keeping them dimmer than hints
  avoids confusing an example with a typed value.
- Dimmed rows (deleted / not-indexed documents, ingest errors) use
  `opacity-70` / `opacity-80`, the lowest levels that keep AA contrast.
  Deleted documents are struck through with a red badge; not-indexed ones are
  italic with a gray badge.
- Only the existing dark theme is affected; the app ships no light theme.

`packages/web/src/__tests__/readability-contrast.test.ts` computes these
contrast ratios and fails if sub-AA grays or sub-11px text come back on the
screens it lists.

## Procedure (Windows 10/11, installed desktop build)

1. Record the installed version (from the installer file name or Windows "Installed apps").
2. For each display scaling setting — **100 %, 125 % and 150 %**
   (Settings → System → Display → Scale), restart the app after changing it:
   1. Maximize the window, then resize it to the minimum size
      (900 × 600, set in `apps/desktop/src-tauri/tauri.conf.json`).
   2. Visit **Sources**: the list, the add-source dialog (every step),
      a source's folder tree, the sync history and the ingestion status card.
   3. Visit a **knowledge base** profile: the document access selector
      (expand nested folders, deleted and not-indexed documents, the
      "auto-include" / "strict" badges and the save footer).
   4. Visit an **MCP** detail page: the configuration, the token/usage card
      and the embedding settings.
   5. On each screen check: secondary text is readable without leaning in;
      no badge, button label or column header is truncated or overflows its
      container; no horizontal scroll bar appears at 900px wide; deleted and
      not-indexed rows remain distinguishable.
3. Optionally, with Windows contrast themes turned on (Settings →
   Accessibility → Contrast themes), check that the screens remain usable.
4. Note any failure with the scaling level, window size and a screenshot.

## Limits

- None of these changes have been checked on Windows yet. Verification so
  far is the automated contrast test plus the format, lint, typecheck and
  unit test runs on macOS.
- Font rendering (ClearType vs macOS antialiasing) and WebView2 zoom at
  125/150 % can change how 11px text and truncation look; only a run on
  Windows can confirm them.
- Contrast ratios assume Tailwind's default palette and the default accent
  color; a custom accent from the branding settings is not covered.
- Windows contrast themes are not specifically supported by the app and were
  not tested.
