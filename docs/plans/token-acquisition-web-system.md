# Superseded: separate Token web system

> **Superseded by:** [OpenList token service design](../superpowers/specs/2026-08-01-openlist-token-service-design.md)

No separate Token web system is planned for this plugin version. Authorization is performed on the configured OpenList authorization page, and the user manually pastes only the resulting refresh token into the loopback setup page.

OpenList is used for authorization and refresh only. File discovery and file uploads continue directly between Pan Sync Helper and Aliyun Drive.
