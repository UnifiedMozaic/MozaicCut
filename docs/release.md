# リリースの出し方

MozaicCut の版は GitHub Releases に置きます。自動更新は、ここに置いたファイルの名前と `SHA256SUMS.txt` に頼るので、
下の「置かれるもの」の名前は変えないでください。

## 版の付け方

タグは `vMAJOR.MINOR.PATCH` の形にします（例: `v0.3.0`）。

- **PATCH**（0.2.0 → 0.2.1）: 誤りの修正と速さの改良だけ。使い方は変わらない。例: 再生のカクつきを直した → 0.2.1
- **MINOR**（0.2.x → 0.3.0）: 機能を足す。前の版で作ったプロジェクトはそのまま開ける。例: 自動更新を足した → 0.3.0
- **MAJOR**（0.x → 1.0.0）: .mzc の書き方が変わり、前の版でプロジェクトを開けなくなるとき、または大きく作り直したとき。
- **0.x のあいだ**はまだ育てている途中なので、MINOR を上げるときに .mzc の書き方を変えてもよい。
- **プレリリース**は `vX.Y.Z-beta.N`（例: `v0.3.0-beta.1`）。GitHub では「Pre-release」の印が付く。
  自動更新は、ふつうの利用者にプレリリースを勧めない（Releases の `prerelease` が true のものは飛ばす）。

版の番号はタグから自動で決まります。**ファイルに版の番号を手で書かない**でください。
`src/gen/version.um` はビルドのたびに作り直す生成物で、リポジトリに入っている `0.2.0` は、タグも `MOZCUT_VERSION` もないときの予備の値です。

## 出す手順

1. main に載せて push したコミットだけにタグを付けます（手元だけのコミットや、ほかのブランチには付けない）。
2. `CHANGELOG.md` の一番上に、その版の節を日本語で足して、main に push します。見出しは `## [0.3.0] - 2026-12-01` の形です。
   リリースのジョブは、この見出しから次の `## ` の前までを GitHub Release の本文にします。**節がないとリリースは止まります。**
3. タグを付けて push します。

   ```sh
   git switch main && git pull
   git tag v0.3.0
   git push origin v0.3.0
   ```

4. GitHub の［Actions］→［build］で、Windows と macOS の `package` が通ったあと、`release` のジョブが Release を作ります。
   どちらかの `package` が落ちたら Release は作られません。直したら、タグを消して付け直すか、PATCH を上げた新しいタグを付けます。

［Run workflow］（workflow_dispatch）で動かしたときは、いままでどおり成果物（Artifacts）を置くだけで、Release は作りません。

## 置かれるもの

タグ `v0.3.0` なら、Release「MozaicCut 0.3.0」に次の 3 つが置かれます。

| 名前 | 中身 |
| --- | --- |
| `MozaicCut-windows-x64.zip` | `dist/MozaicCut/` を zip にしたもの（中は `MozaicCut/` のフォルダ 1 つ。`MozaicCut/MozaicCut.exe` と DLL など） |
| `MozaicCut-macos-arm64.zip` | `dist/MozaicCut.app` を `ditto -c -k --keepParent` で zip にしたもの（中は `MozaicCut.app/`。ad-hoc の署名、公証なし） |
| `SHA256SUMS.txt` | 上の 2 つの SHA-256（`sha256sum` の形。1 行に `<16 進 64 字>  <名前>`） |

- 名前に版の番号は入りません。自動更新は、最新の Release（`https://api.github.com/repos/UnifiedMozaic/MozaicCut/releases/latest`
  は prerelease を返さない）から、この決まった名前のファイルを取り、`SHA256SUMS.txt` で確かめます。
- タグの `v` を除いたもの（`0.3.0`）が、ビルドのときに `MOZCUT_VERSION` として渡され、アプリの版になります。
  - 編集画面の中では `src/gen/version.um` の `MOZCUT_VERSION`（と CI で作ったときのコミット `MOZCUT_COMMIT`）。
    「ヘルプ」→「MozaicCut について」に出ます。自動更新は、この値と Release のタグを比べます。
  - macOS の `Info.plist` の `CFBundleShortVersionString` / `CFBundleVersion` も同じ値です。

## 版の決まり方（ビルド）

`node tools/mozcut.mjs build` と `package` は、ビルドの前に `tools/gen-version.mjs` で `src/gen/version.um` を作ります（中身が同じなら書きません）。

1. 環境変数 `MOZCUT_VERSION`（`1.2.3` か `1.2.3-beta.1`）
2. `git describe --tags` がちょうど `vX.Y.Z`（タグを付けたコミットそのもの）なら `X.Y.Z`
3. どちらもなければ既定の `0.2.0`

手元でタグのコミットをビルドすると `src/gen/version.um` が書き換わることがあります。その変更はコミットしないでください
（`git checkout src/gen/version.um` で戻す）。`node tools/gen-version.mjs --check`（tests/ui が流す）は、ファイルの形だけを確かめるので、
版が変わっていても落ちません。

## 自動更新

配布の形の MozaicCut（Windows の `MozaicCut/MozaicCut.exe`、macOS の `MozaicCut.app`）は、GitHub Releases の最新の版を
自分で確かめ、利用者が押したときだけ入れ替えます。勝手には入れ替えません。中身は `src/editor/upd_*.um`（裏のスレッド・
SHA-256・版の比べ方・入れ替え）と `src/editor/wire_update.um`（状態の帯と設定へのつなぎ）です。

### 利用者から見えること

1. **確かめる**: 設定の欄の「更新」の「更新を確かめる」がオン（既定）なら、起動したときと 6 時間ごとに、裏のスレッドで
   `https://api.github.com/repos/UnifiedMozaic/MozaicCut/releases/latest` を取ります（`prerelease` のものは返らないので、
   ふつうの利用者にプレリリースは勧めません）。通信するのは **1 日に 1 回まで** で、最後に確かめた時刻と最新の版を
   `<設定のフォルダ>/update/last-check.txt` に書きます（設定のフォルダは `%APPDATA%/MozaicCut`、macOS などは
   `~/.config/MozaicCut`）。1 日たっていなければ、記録した版で答えます。送るのは `User-Agent: MozaicCut-updater` と `Accept` だけです。
   - UM には暦の時刻の組み込みがないので、今の時刻は、小さなファイルを `tar`（Windows は `System32\tar.exe`、macOS は
     `/usr/bin/tar`）で ustar にまとめ、見出しの mtime から読みます。`tar` が使えないときは、起動ごとに 1 回確かめます。
   - ヘルプのメニューの「更新を確かめる」と、設定の［今すぐ確かめる］は、1 日の決まりを待たずにすぐ確かめます。
   - オフラインや GitHub の誤りでは、自動の確かめは何も出しません。手で頼んだときだけ、状態の帯に理由を出します。
2. **知らせる**: 新しい版（semver で比べる。`0.10.0 > 0.9.9`、プレリリースは同じ X.Y.Z の正式の版より小さい）があれば、
   状態の帯の右に「新しい版 X.Y.Z があります」と［更新］を出します。
3. **落とす**: ［更新］を押すと、この OS の zip（`MozaicCut-windows-x64.zip` か `MozaicCut-macos-arm64.zip`）と
   `SHA256SUMS.txt` を HTTPS で `<設定のフォルダ>/update/` に落とし（状態の帯に進み具合）、受け取りながら計算した SHA-256 を
   `SHA256SUMS.txt` と照らします。合わなければ消して、状態の帯に理由を出します。合えば、OS の道具（Windows は
   `%SystemRoot%\System32\tar.exe -xf`、macOS は `/usr/bin/ditto -x -k`）で、入っている所の隣の `<単位>.update/` に展開し、
   一番上の `MozaicCut/MozaicCut.exe`（macOS は `MozaicCut.app/Contents/MacOS/MozaicCut`）があることを確かめます。
   展開を設定のフォルダでなく隣で行うのは、入れ替え（名前の変更）が同じドライブの中でしかできないためです。
4. **入れ替える**: 状態の帯は「閉じると新しい版 X.Y.Z に入れ替えます」と［今すぐ再起動］になります。閉じると（か［今すぐ再起動］）、
   古い版は `<単位>.update/old.lock` を開いたまま、新しい版を `--finish-update <単位> <古い pid> <設定のフォルダ> <0|1>` で
   切り離して始めて終わります。新しい版は、古い版が終わるのを待ち（Windows は old.lock を消せるようになるまで、macOS は
   `kill -0 <pid>` が失敗するまで。60 秒まで）、単位の中身を `<単位>.old/` へ移し、新しい中身を単位へ移します。途中で失敗したら
   元に戻し、前の版のまま動きます。結果は `<設定のフォルダ>/update/finish.txt` に書き、次に開いたときに状態の帯に出します。
   最後の引数が 1（［今すぐ再起動］）なら、入れ替えたあとで MozaicCut を始め直します。
   - 単位（Windows は `MozaicCut.exe` のフォルダ、macOS は `MozaicCut.app`）のフォルダそのものではなく中身を動かすのは、
     Windows では古い版の「今いるフォルダ」（ダブルクリックで始めたなら単位）を新しい版が受け継ぎ、単位の名前を変えられないためです。
   - 次にふつうに開いたとき、`<単位>.old/` と `<単位>.update/` を消します。
   - `--finish-update` の引数の形は、前の版が新しい版を始めるときに使うので、**変えないでください**。
5. **入れ替えないとき**: 開発用のビルド（`build/mozcut-edit.exe` や、git のチェックアウトの中の `dist/`）と、zip のない OS（Linux）は
   入れ替えません。［更新］を押すと、理由とリリースのページのアドレスを状態の帯に出します。開発用のビルドは、自動の確かめもしません
   （メニューの「更新を確かめる」は使えます）。入っているフォルダに書けない（`Program Files` など）ときは、展開のところで理由を出します。

### 試し方

ネットワークなしで、`node tests/run.mjs update` が手元の試しのサーバー（別のプロセスの Node）を立てて確かめます
（Windows だけ。新しい版を見つけて落とし、SHA-256 を照らして展開する・合わない zip を断る・`--finish-update` の入れ替えと
次の起動の片付け）。SHA-256 と版の比べ方は `node tests/ui/run.mjs upd` です。

手で試すときは、次の環境変数を使います（ふつうの利用では使いません）。

| 環境変数 | 働き |
| --- | --- |
| `MOZCUT_UPDATE_URL` | releases/latest の代わりに取る URL（例: `http://127.0.0.1:8123/latest`）。あると `--frames` の試しでも自動で確かめ、終わるまで（45 秒まで）フレームを続ける |
| `MOZCUT_UPDATE_INSTALL_DIR` | 入れ替える単位（開発用のビルドの見分けを飛ばす）。展開は `<これ>.update/` に行う |
| `MOZCUT_UPDATE_AUTO_INSTALL` | `MOZCUT_UPDATE_URL` があるとき、新しい版を見つけたら［更新］を押したことにする |
| `MOZCUT_UPDATE_NO_LAUNCH` | 終わるときに入れ替えを始めない。`--finish-update` は入れ替えたあとで起動しない |
| `MOZCUT_UPDATE_NEW_DIR` | `--finish-update` が入れる新しい中身のフォルダ（既定は、その実行ファイルの単位） |

`--stats` を付けると、終わるときに `update: {"phase":...,"latest":...,"status":...}` を標準エラーに出します。

本物の GitHub Release での入れ替え（とくに macOS）は、上の試しでは確かめていません。リリースを出したら、前の版の配布の形を
手元に置いて［更新］→［今すぐ再起動］を 1 回試してください。
