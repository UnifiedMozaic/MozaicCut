# アプリのアイコン

UnifiedMozaic の印（M の下に U）の下に、タイムラインのクリップを 2 段並べた形。UnifiedMozaic のアイコンと同じく、黒い角丸の板に白で描き、色は白と黒の 2 色だけ（2 段目のクリップは白の 50%）。

| ファイル | 中身 |
|---|---|
| `mozaiccut.svg` | 元の形（48px 以上で使う） |
| `mozaiccut-small.svg` | 32px 以下で使う形（印を大きく、クリップを太い 1 段に） |
| `png/mozaiccut-<大きさ>.png` | 16〜1024px の画像（生成物） |
| `mozaiccut.ico` | Windows 用（16〜256px。生成物） |
| `mozaiccut.icns` | macOS 用（16〜1024px。生成物） |

生成物は `node tools/gen-icon.mjs` で作り直す（SVG を画素にするのにヘッドレスの Chrome か Edge を使う）。SVG を直したら、生成物も同じコミットに入れる。
