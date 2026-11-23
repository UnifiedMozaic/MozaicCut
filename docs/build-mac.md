# Mac 版のビルド

MozaicCut を Mac（Apple シリコン、arm64）でビルドし、`dist/MozaicCut.app` を作る手順です。

> **まだ Mac で動かして確かめていません。** この手順と `node tools/mozcut.mjs package` の macOS の部分（`tools/package.mjs` の
> `makeMacApp`）、`.github/workflows/build.yml` は、Mac のない Windows の PC で書きました。確かめたのは、Windows の配布の形が
> 前と同じに作られることと、macOS の部分が node のコードとして読め、Windows で呼んでも壊れないことだけです。
> 初めて Mac で動かすときは、下の「確かめていないこと」も見てください。

## 要るもの

- Apple シリコンの Mac、macOS 13 以降
- Xcode の Command Line Tools: `xcode-select --install`（clang・otool・install_name_tool・codesign）
- [Homebrew](https://brew.sh/)
- Node.js 22.18 以降: `brew install node`
- UnifiedMozaic（コンパイラ）: このリポジトリの隣に `git clone https://github.com/UnifiedMozaic/UnifiedMozaic.git`
  （ほかの場所なら環境変数 `UM_HOME` にその場所を設定する）
- ライブラリ: SDL3、wasmtime の C API、wgpu-native、FFmpeg（共有ライブラリ）

## ライブラリを揃える

### おすすめ: CI と同じスクリプトで揃える

GitHub Actions が使う `.github/ci/install-deps.sh` は、手元の Mac でも動きます。どれも同じ版（wasmtime 51.0.0、wgpu-native 29.0.1.1、
SDL3 3.4.20、FFmpeg 9.0）を、公式の配布物かソースから `~/mozcut-deps` に置き、設定する環境変数を `名前=値` の形で出します。
SDL3 と FFmpeg はソースからビルドするので、初回は 10〜20 分かかります。

```sh
brew install cmake llvm lld
cd MozaicCut
eval "$(UM_DEPS=$HOME/mozcut-deps bash .github/ci/install-deps.sh | grep -E '^[A-Z_]+=' | sed 's/^/export /')"
echo "$UM_SDL3 $UM_WASMTIME $UM_WGPU_HOME $UM_FFMPEG_HOME"
```

環境変数（`UM_SDL3`・`UM_WASMTIME`・`UM_WGPU_HOME`・`UM_FFMPEG_HOME`）は、新しいターミナルでは消えます。続けて使うなら、
出てきた 4 行を `~/.zshrc` に `export UM_SDL3=...` の形で書いておきます。

FFmpeg は LGPL の構成（`--enable-gpl` なし、外部のライブラリなし、H.264 の符号化は OS の VideoToolbox）でビルドします。
配る .app には、この構成の FFmpeg を使ってください。

### 手で揃える

- **SDL3**: `brew install sdl3`。mozcut.mjs と UnifiedMozaic が `/opt/homebrew/opt/sdl3` を自動で見つけます。
- **wasmtime の C API**: [releases](https://github.com/bytecodealliance/wasmtime/releases/tag/v51.0.0) の
  `wasmtime-v51.0.0-aarch64-macos-c-api.tar.xz` をホームフォルダ（かこのリポジトリの隣）に展開します（`~/wasmtime-*` を自動で探します）。
- **wgpu-native**: [releases](https://github.com/gfx-rs/wgpu-native/releases/tag/v29.0.1.1) の `wgpu-macos-aarch64-release.zip` を
  `~/wgpu-native/v29.0.1.1/` に展開します（`~/wgpu-native/<版>` を自動で探します）。
- **FFmpeg**: `brew install ffmpeg` でも動きますが、Homebrew の ffmpeg は **GPL の構成**（x264・x265 など）です。自分で使うだけなら
  かまいませんが、配るときは上のスクリプトで LGPL の構成をビルドしてください（GPL の構成のまま `package` を作ると、注意を出し、
  告知の文書にもそう書きます）。

wasmtime と wgpu-native の配布物の dylib は、名前（install name）が `@rpath/…` でないことがあります。そのままだと、ビルドした
`build/mozcut-edit` が起動のときに見つけられないので、`install-deps.sh` と同じく直しておきます。

```sh
for lib in ~/wasmtime-v51.0.0-aarch64-macos-c-api/lib/libwasmtime.dylib ~/wgpu-native/v29.0.1.1/lib/libwgpu_native.dylib; do
  install_name_tool -id "@rpath/$(basename "$lib")" "$lib" && codesign --force --sign - "$lib"
done
```

## ビルドと .app の作り方

```sh
cd MozaicCut
node tools/mozcut.mjs build      # build/mozcut（エンジン）と build/mozcut-edit（編集画面）
node tools/mozcut.mjs package    # dist/MozaicCut.app
open dist/MozaicCut.app
```

`package` は次のことをします（`tools/package.mjs` の `makeMacApp`）。

- `Contents/MacOS/MozaicCut` に編集画面の実行ファイルを入れる
- 実行ファイルが読み込む dylib を `otool -L` でたどって `Contents/Frameworks` に写す（`/usr/lib` と `/System` の OS のものは入れない）
- `install_name_tool` で、読み込む名前を `@rpath/<名前>` に、実行ファイルの rpath を `@executable_path/../Frameworks` に、
  dylib の rpath を `@loader_path` に直す（ビルドした Mac の絶対パスの rpath は消す）。.app の外を読み込んだままなら止まる
- `Contents/Resources` に `mozaiccut.icns`（アイコン）・`tokens.json`・`THIRD-PARTY-NOTICES.txt`・`licenses/` を置く
- `Info.plist` を書く: 名前 MozaicCut、識別子 `com.mozaiccut.app`、版（環境変数 `MOZCUT_VERSION`、なければ 0.2.0）、
  アイコン、.mzc の文書の型（`com.mozaiccut.project`）
- ad-hoc の署名（`codesign --force --sign -`）をし、`codesign --verify --deep --strict` で確かめる

できたものを確かめるには:

```sh
otool -L dist/MozaicCut.app/Contents/MacOS/MozaicCut   # OS のものと @rpath/… だけのはず
codesign -dv dist/MozaicCut.app                        # Signature=adhoc
```

## 署名と公証、初回の起動（Gatekeeper）

`package` の署名は **ad-hoc**（`codesign -s -`）で、Apple の**公証（notarization）はしていません**。公証には Apple Developer Program
（有料）の Developer ID の証明書が要るためです。

- **自分の Mac でビルドした .app**: ダウンロードしたものではない（隔離の印 `com.apple.quarantine` が付いていない）ので、
  そのまま `open` やダブルクリックで開けます。
- **ほかの人から受け取った .app（GitHub の成果物の zip など）**: macOS が「開発元を確認できないため開けません」などと止めます。
  macOS 15 では、Control キーを押しながらのクリックの「開く」では通れません。次のどちらかで開きます。
  1. 一度開こうとしてから、［システム設定］→［プライバシーとセキュリティ］の下の方の「"MozaicCut"は開けませんでした」の
     ［このまま開く］を押し、もう一度開く
  2. ターミナルで隔離の印を外す: `xattr -dr com.apple.quarantine /Applications/MozaicCut.app`

  受け取った人がこの手順を踏まなくてよくするには、Developer ID で署名して公証する必要があります
  （`codesign --options runtime --sign "Developer ID Application: …"`、`xcrun notarytool submit … --wait`、`xcrun stapler staple`）。
  これはまだ用意していません。

## Mac 版の設定の置き場所

最近の一覧などは `~/.config/MozaicCut/`（`XDG_CONFIG_HOME` があればその下）に置きます（`src/editor.um` の `e2GuessHome`）。
Mac の習わしの `~/Library/Application Support/` ではありません。

## GitHub Actions で作る

`.github/workflows/build.yml` は、Windows（windows-2025）と macOS（macos-15、arm64）で `node tools/mozcut.mjs package` を流し、
成果物（artifact）として置きます。

- Windows: `MozaicCut-windows-x64`（`dist/MozaicCut/` のフォルダ）
- macOS: `MozaicCut-macos-arm64`（`.app` を `ditto` で zip にしたもの。成果物は実行の許可と記号のリンクを残さないので zip にする）

ライブラリは `.github/ci/install-deps.sh` が揃え、`actions/cache` で次の実行に残します。UnifiedMozaic は、
`UnifiedMozaic/UnifiedMozaic` のリポジトリを隣に checkout します。

**このワークフローは、まだ一度も GitHub で動かしていません**（このリポジトリを GitHub に置いていないため）。動かすには、利用者が次のことをします。

1. GitHub にこのリポジトリを作って push する
2. UnifiedMozaic について:
   - MozaicCut が使っている機能（たとえば `envVar` の組み込み）を含む版が GitHub の `UnifiedMozaic/UnifiedMozaic` に
     push されていること。手元の UnifiedMozaic が GitHub より新しいなら、先に push する
   - 決まった版を使うなら、リポジトリの［Settings］→［Secrets and variables］→［Actions］→［Variables］に `UM_REF`
     （ブランチかタグかコミット）を作る。なければ `main` を使う
   - UnifiedMozaic のリポジトリが非公開なら、読める token を secret に置き、build.yml の 2 つ目の checkout に
     `token: ${{ secrets.<名前> }}` を足す
3. ［Actions］→［build］→［Run workflow］で動かす（`v1.2.3` のようなタグを push しても動き、その版が Info.plist に入る）
4. 実行の画面の下の［Artifacts］から zip を取る

初回はライブラリのビルド（SDL3・FFmpeg）で macOS が 20〜30 分ほどかかる見込みです。落ちたときは、ログの `deps` か `package` の段を見てください。

## 確かめていないこと

Mac がないので、次のことは分かっていません。初めて Mac で動かすときに見てください。

- `makeMacApp` が実際の otool・install_name_tool・codesign で最後まで通るか（とくに、ヘッダーの空きが足りず
  install_name_tool が名前を書き換えられない場合）
- .app を開いて、スタート画面が出て、プロジェクトを開き、再生と書き出しができるか
- 画面の文字: 和文のフォントは、Mac では `/System/Library/Fonts/Supplemental/Arial Unicode.ttf` を予備に使う（`src/ui/theme_font.um`）。
  ヒラギノは候補に入っていない
- Finder で .mzc をダブルクリックしたときに開くか。macOS はファイルを引数ではなく Apple Event で渡す（SDL3 はそれを
  ドロップのイベントにする）ので、編集画面の側で扱えているかは分からない
- H.264 の書き出しが VideoToolbox の符号器で動くか
- GitHub Actions のワークフロー全体
