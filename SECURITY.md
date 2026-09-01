# Security Policy

## Sensitive data

Never commit north session cookies, browser profiles, passwords, Turnstile tokens, generated private data, or local environment files. The repository ignores `.env*`, `*.cookie`, `data/`, `.makeitaquote/`, and `node_modules/`, but verify `git status` before every public push.

Do not post session cookies, request headers, or authentication screenshots in public issues or pull requests.

## Reporting

For a security issue in this project, avoid including secrets in the report. Contact the repository owner privately through GitHub before public disclosure.
