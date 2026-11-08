# Smart Tabs

Smart Tabs is an independent Chrome extension for organizing Claude and ChatGPT project tabs with Chrome tab groups.

## Current release candidate

Version 6.39.0. This repository update publishes the active source and English documentation for the Smart Tabs release candidate.

## Features

- Bind a Claude or ChatGPT project URL to a Chrome tab group.
- Open a bound project when creating a new tab inside that group.
- Create and reuse project groups through the extension popup.
- Recover from stale ChatGPT project links when the page reports a missing project.

## Permissions

The extension uses Chrome `tabs`, `tabGroups`, `storage`, `contextMenus`, and `scripting` permissions, with host access limited to Claude and ChatGPT pages used by the project-binding workflow. See `privacy-policy.html`.

## Validation

This release candidate has passed Manifest/reference, JavaScript syntax, checksum, and static smoke checks. Full browser regression and Chrome Web Store review remain separate gates.

## Relationship to Claude and ChatGPT

Smart Tabs is independent and is not affiliated with, endorsed by, or produced by Anthropic or OpenAI.
