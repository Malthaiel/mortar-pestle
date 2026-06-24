// "Reveal in files" helper shared by every tree-sidebar toolbar. Folder targets
// open INTO the folder (open_path, shows contents); a specific file highlights in
// its parent (reveal_in_files). Both Rust commands enforce the same allowed-root
// containment check (content vault + library vault + app vault + media roots).
// A relative path resolves server-side against the named mount via `root`
// ('app' / 'pulse' / 'library'; default content), so e.g. Docs can target the App
// vault without hardcoding an absolute home path. Absolute paths pass straight
// through. open_path takes `root`; reveal_in_files (file targets) does not.

import { invoke } from '../../api.js';

export function openInFiles(path, { isFolder = true, root } = {}) {
  const cmd = isFolder ? 'open_path' : 'reveal_in_files';
  const args = (root && isFolder) ? { path, root } : { path };
  return invoke(cmd, args).catch((e) => console.error('reveal in files failed:', e));
}
