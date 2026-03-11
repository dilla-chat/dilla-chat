# Contributing to Slimcord

Thank you for your interest in contributing to Slimcord! This document provides guidelines for contributing to the project.

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/slimcord.git
   cd slimcord
   ```
3. **Create a branch** for your feature or fix:
   ```bash
   git checkout -b feat/my-feature
   ```

## Development Setup

### Server (Go)
```bash
cd server
go mod download
make build
```

### Client (Tauri + React)
```bash
cd client
npm install
npm run dev       # Web-only dev server
npm run tauri dev # Full Tauri dev mode
```

## Code Style

### TypeScript / React
- Use functional components with hooks
- Use TypeScript strict mode
- Format with Prettier (`npm run format`)
- Lint with ESLint (`npm run lint`)

### Go
- Follow standard Go conventions (`go fmt`, `go vet`)
- Use meaningful variable names
- Add comments for exported functions

### CSS
- Use CSS custom properties (variables) from `src/styles/theme.css`
- Do not hardcode colors — always reference theme variables
- Use BEM-like naming for CSS classes

## Commit Messages

Use clear, descriptive commit messages:

```
feat: add keyboard shortcuts for channel navigation
fix: resolve theme toggle not persisting on reload
docs: update README with federation setup instructions
```

Prefix with: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`

## Pull Requests

1. Ensure your code builds without errors (`npm run build` for client, `make build` for server)
2. Run linters and fix any issues
3. Write a clear PR description explaining what changed and why
4. Reference related issues with `Fixes #123` or `Closes #123`
5. Keep PRs focused — one feature or fix per PR

## Reporting Issues

- Use GitHub Issues to report bugs or request features
- Include steps to reproduce for bug reports
- Include your OS, Node.js version, Go version, and Rust version

## Security

If you discover a security vulnerability, please report it responsibly. Do **not** open a public issue. Instead, email the maintainers directly.

## License

By contributing, you agree that your contributions will be licensed under the AGPLv3 license.
