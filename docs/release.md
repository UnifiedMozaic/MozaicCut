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
