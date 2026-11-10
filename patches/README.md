# Edited copies of other people's libraries

Each folder here is a library by someone else, at one exact release, with a few lines changed by us. The root `Cargo.toml` `[patch.crates-io]` table points the build at them, and its comments say why each edit exists and whether the maker's next release ends it.

These folders are **not** under this repo's licence. Each stays under its maker's own terms; the licence text sits in the folder.

| Folder | Release | Maker | Licence | Our edit (`<name>.diff`) |
|---|---|---|---|---|
| `softbuffer` | 0.4.8 | [rust-windowing/softbuffer](https://github.com/rust-windowing/softbuffer) | MIT OR Apache-2.0 | see-through Wayland surfaces: 1 file, 4 changed lines |
| `iced_tiny_skia` | 0.14.1 | [iced-rs/iced](https://github.com/iced-rs/iced) | MIT | eight fixes to the CPU painter: 4 files, 253 changed lines |
| `exwlshellev` | 0.21.2 | [waycrate/exwlshelleventloop](https://github.com/waycrate/exwlshelleventloop) | MIT | a layer surface's size change travels with its next frame: 2 files, 116 changed lines |
| `iced_exwlshell` | 0.21.2 | [waycrate/exwlshelleventloop](https://github.com/waycrate/exwlshelleventloop) | MIT | the mouse's back and forward buttons (1 file, 8 changed lines) + two exact pins in its `Cargo.toml` |

## The diff files

`<name>.diff` is exactly what we changed against the maker's release (plus the licence text where the published package carries none). Read it instead of hunting through the folder.

## Making a copy again

```sh
patches/remake.sh <name> <version>          # the maker's release + <name>.diff -> patches/<name>
patches/remake.sh --diff <name> <version>   # write <name>.diff again from patches/<name>
```

Moving a copy to a newer release: run the first line with the new version, mend whatever part of the diff no longer fits, build, then run the second line. Leave out every fix the root `Cargo.toml` marks GOES once its release is the base. Files no app builds (`examples/`, `benches/`, `tests/`, the makers' lock files, a README the library does not read at build time) are left out of the copies.

## The exwlshell family is pinned

The two exwlshell copies are release 0.21.2, and the maker's other packages of that release must stay there with them. Four exact pins (`=0.21.2`) hold them: `iced_exwlshell` and `iced_wayland_subscriber` in `apps/shell/Cargo.toml`, `iced_exwlshell_macros` and `iced_exdevtools` in `patches/iced_exwlshell/Cargo.toml`. Without them a `cargo update` takes the 0.21.4 ones and the build stops (tried 2026-11-10: with all four in, a full `cargo update` builds). Lift all four only together with a re-make of both copies.
