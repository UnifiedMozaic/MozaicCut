#!/usr/bin/env bash
# 3 通りの実行（UM 本体・WGSL・wasm）の比較をまとめて流す。作業ツリーの根で実行する:
#   UM=<UnifiedMozaic> UM_WASMTIME=<wasmtime の C API> UM_WGPU_HOME=<wgpu-native> bash src/effects/fxs/test_three.sh [名前 ...]
# 名前を省くと、例のエフェクト 10 個と examples/*.fxs 6 個と testdata/three_*.fxs 3 個のすべて。結果の表は build/fxs-three/result.txt。
# 引数の前に BIG=1 を付けると 1920x1080 でも測る。
set -u
UM=${UM:-C:/Users/mozuku/UnifiedMozaic}
export UM_WGPU=1
export UM_WGPU_HOME=${UM_WGPU_HOME:-'C:\Users\mozuku\wgpu-native\v29.0.1.1'}
export UM_WASMTIME=${UM_WASMTIME:-'C:\Users\mozuku\wasmtime-v51.0.0-x86_64-windows-c-api'}
export SDL_VIDEO_DRIVER=offscreen
names=("$@")
if [ ${#names[@]} -eq 0 ]; then
  names=(chroma crt edges glitch glow grain halftone kaleido posterize ripple vignette wave crossfade kitchen semantics edge three_nanfold three_loop three_table)
fi
all=(chroma crt edges glitch glow grain halftone kaleido posterize ripple vignette wave crossfade kitchen semantics edge three_nanfold three_loop three_table)
mkdir -p build/fxs-three
node "$UM/src/cli.ts" build src/effects/fxs/test_three.um --target host -o build/fxs_three || exit 1
./build/fxs_three > build/fxs-three/gen.txt || { cat build/fxs-three/gen.txt; exit 1; }
: > build/fxs-three/result.txt
fails=0
for n in "${names[@]}"; do
  echo "== $n"
  if ! node "$UM/src/cli.ts" build "build/fxs-three/$n/main.um" --target host -o "build/fxs-three/$n/run" > "build/fxs-three/$n/build.txt" 2>&1; then
    cat "build/fxs-three/$n/build.txt"; fails=$((fails+1)); continue
  fi
  "./build/fxs-three/$n/run" > "build/fxs-three/$n/out.txt" 2>&1
  code=$?
  tail -n 8 "build/fxs-three/$n/out.txt"
  grep '^RESULT' "build/fxs-three/$n/out.txt" >> build/fxs-three/result.txt
  if [ "${BIG:-0}" = 1 ]; then
    "./build/fxs-three/$n/run" big > "build/fxs-three/$n/out1080.txt" 2>&1
    grep '^RESULT' "build/fxs-three/$n/out1080.txt" | sed 's/^RESULT/RESULT1080/' >> build/fxs-three/result.txt
  fi
  [ $code -eq 0 ] || fails=$((fails+1))
done
echo "合わなかったもの: $fails"
[ $fails -eq 0 ]
