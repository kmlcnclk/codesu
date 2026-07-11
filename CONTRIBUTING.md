# 🤝 Contributing to Codesu

Thank you for your interest in contributing to Codesu! This guide will help you get started.

---

## Code of Conduct

Be respectful, inclusive, and constructive in all interactions. We're building a friendly community for developers of all levels.

---

## Getting Started

### 1. Fork & Clone
```bash
git clone https://github.com/kmlcnclk/codesu.git
cd codesu
```

### 2. Install Dependencies
```bash
pnpm install
```

### 3. Start Development
```bash
pnpm tauri dev
```

This builds the frontend and opens the Tauri desktop app in development mode with
hot reload. (`pnpm dev` alone runs only the Vite frontend server in a browser —
use `pnpm tauri dev` for the full app.)

---

## Development Setup

### Prerequisites
- **Node.js** 18+
- **pnpm** (install with `npm install -g pnpm`)
- **Rust** 1.70+ (install from [rustup.rs](https://rustup.rs/))
- **Git**

### Recommended Tools
- **VS Code** with Svelte, Tauri, and rust-analyzer extensions
- **GitHub CLI** (`gh`) for PR creation
- **Git** for version control

### First Run
```bash
# Install dependencies
pnpm install

# Start the full desktop app in dev mode
pnpm tauri dev

# In another terminal, watch for TypeScript errors
pnpm check:watch
```

---

## Project Structure

**Frontend** (TypeScript + Svelte)
- `src/lib/components/` — Reusable Svelte components
- `src/lib/store/` — Centralized state management
- `src/lib/terminal/` — Terminal emulation logic
- `src/routes/` — Page layouts and routes
- `src/app.css` — Global styles

**Backend** (Rust)
- `src-tauri/src/main.rs` — App entry point
- `src-tauri/src/lib.rs` — Tauri command handlers
- `src-tauri/src/pty.rs` — PTY/terminal management
- `src-tauri/src/git.rs` — Git worktree operations
- `src-tauri/src/store.rs` — Persistent state

---

## Making Changes

### Branch Naming
- `feat/...` — New features
- `fix/...` — Bug fixes
- `chore/...` — Refactoring, dependencies, docs
- `docs/...` — Documentation only

Example: `feat/agent-templates` or `fix/terminal-resize`

### Commit Messages
Write clear, descriptive commit messages:

```
feat: add agent templates system

- Allow users to create reusable agent configurations
- Add template gallery with built-in options
- Add template import/export functionality
```

### Code Style

**TypeScript/Svelte:**
- 2 spaces for indentation
- Semicolons (match the existing code)
- Use `const` by default, `let` when needed
- Descriptive variable names

**Rust:**
- Follow standard Rust conventions
- Run `cargo fmt` before committing
- Keep `cargo clippy` clean (the project builds warning-free)

### Testing

Before submitting a PR, run all checks:
```bash
# Frontend: type-check (0 errors expected)
pnpm check

# Frontend: production build
pnpm build

# Backend: unit tests + lint (run from src-tauri/)
cd src-tauri
cargo test
cargo clippy
```
The Rust backend has unit tests (e.g. state persistence and migration in
`src-tauri/src/store.rs`). Add tests for new backend logic where practical.

---

## Common Tasks

### Adding a New UI Component

1. Create component in `src/lib/components/MyComponent.svelte`
2. Define props with TypeScript:
   ```svelte
   <script lang="ts">
     export let title: string;
     export let items: Array<{ id: string; label: string }>;
   </script>
   ```
3. Import and use in pages/other components
4. Test across different screen sizes

### Adding a Tauri Command

1. Add handler in `src-tauri/src/lib.rs`:
   ```rust
   #[tauri::command]
   async fn my_command(window: tauri::Window, arg: String) -> Result<String, String> {
     // Implementation
     Ok("result".to_string())
   }
   ```

2. Call from frontend:
   ```typescript
   import { invoke } from '@tauri-apps/api/core';
   const result = await invoke('my_command', { arg: 'value' });
   ```

### Adding a Feature

1. Create a new branch: `git checkout -b feat/my-feature`
2. Make your changes and commit
3. Test thoroughly
4. Push and create a PR with description
5. Respond to code review feedback
6. Merge when approved

---

## Debugging

### Frontend
- Press **F12** in dev mode to open DevTools
- Use `console.log()` or browser debugger
- Check Network tab for API calls

### Backend
- Use `println!()` macros for debugging
- Run with `RUST_LOG=debug` for more verbose logging
- Use IDE debugger with rust-analyzer

### Terminal Issues
- Check `xterm.js` terminal state in DevTools
- Verify PTY process is running (check `/proc` on Linux)
- Look at stderr output from Tauri process

---

## Pull Request Process

1. **Fork** the repository
2. **Create a branch** from `master`
3. **Make changes** with clear commit messages
4. **Test thoroughly** on your machine
5. **Push** to your fork
6. **Create PR** with:
   - Clear title and description
   - Reference to related issues (#123)
   - Screenshots for UI changes
   - Testing instructions if needed

### PR Guidelines
- Keep PRs focused (one feature per PR)
- Update documentation if needed
- Add tests for new functionality
- Follow existing code style
- Be open to feedback

---

## Reporting Issues

### Bug Reports
Include:
- Clear, descriptive title
- Steps to reproduce
- Expected vs actual behavior
- Screenshots/videos if applicable
- System info (OS, Rust version, Node version)

### Feature Requests
Include:
- Clear description of the feature
- Why it's useful
- Example usage scenarios
- Any design mockups if available

---

## Documentation

### README.md
- Product overview and quick start
- Basic feature list
- Development setup
- Tech stack

### FEATURES.md
- Detailed feature breakdown
- User-facing documentation
- Keyboard shortcuts
- Settings explanations

### Code Comments
- Explain *why*, not *what*
- Use for non-obvious logic only
- Keep comments up-to-date with code

### Commit Messages
- Clear description of changes
- Reference related issues
- Explain reasoning when non-obvious

---

## Performance Considerations

When contributing:
- Minimize re-renders in Svelte components
- Use `bind:` and reactive statements carefully
- Avoid unnecessary API calls
- Profile with DevTools (Performance tab)
- Test with large datasets

---

## Security

- Never commit secrets or credentials
- Use environment variables for config
- Validate user input on both frontend & backend
- Keep dependencies up-to-date
- Report security issues privately

---

## Getting Help

- **Issues**: Ask in related GitHub issues
- **Discussions**: Use GitHub Discussions for questions
- **Discord**: Join our community server (link coming)
- **Docs**: Check README.md and FEATURES.md

---

## Recognition

Contributors will be recognized in:
- CONTRIBUTORS.md file
- Release notes for merged PRs
- Project credit page

Thank you for making Codesu better! 🙏

---

*Happy coding!*
