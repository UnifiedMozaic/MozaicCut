// UnifiedMozaic が kernel 'hosttest' から生成した WGSL（testdata/hosttest.fxs の kernel を --emit-wgsl したもの）。手で編集しない。

struct S_vec4__f32 {
  f_x: f32,
  f_y: f32,
  f_z: f32,
  f_w: f32,
}

struct UmParams {
  count: u32,
  row: u32,
  len_out: u32,
  len_src: u32,
  len_src2: u32,
  p_w: u32,
  p_h: u32,
  p_time: f32,
  p_p: array<f32, 8>,
}

@group(0) @binding(0) var<storage, read> um_params: UmParams;
@group(0) @binding(1) var<storage, read_write> b_out: array<S_vec4__f32>;
@group(0) @binding(2) var<storage, read> b_src: array<S_vec4__f32>;
@group(0) @binding(3) var<storage, read> b_src2: array<S_vec4__f32>;

// 範囲外の添字を最後の要素に切り詰める。長さ 0 の Buffer は1要素ぶん確保されているので 0 を返す。
fn um_clamp(i: u32, len: u32) -> u32 {
  return min(i, max(len, 1u) - 1u);
}

// 浮動小数点から整数へ。範囲外は端の値に飽和し、NaN は 0。変換そのものは範囲内に収めてから行う。
fn um_f2i(v: f32) -> i32 {
  let r: i32 = i32(clamp(v, -2147483648.0f, 2147483520.0f));
  let hi: i32 = select(r, 2147483647i, v >= 2147483648.0f);
  let lo: i32 = select(hi, -2147483647i - 1i, v <= -2147483648.0f);
  return select(lo, 0i, v != v);
}

fn um_f2u(v: f32) -> u32 {
  let r: u32 = u32(clamp(v, 0.0f, 4294967040.0f));
  let hi: u32 = select(r, 4294967295u, v >= 4294967296.0f);
  let lo: u32 = select(hi, 0u, v <= 0.0f);
  return select(lo, 0u, v != v);
}

// 掛け算の結果を、実行時にしか分からない 0（um_main が um_params.row >> 30 を入れる。row は 2^30 未満）と OR する。
// ドライバは結果を足し算と1つの命令（FMA）にまとめられなくなり、CPU と同じく掛け算のあとで1回丸める。
var<private> um_z: u32;
fn um_fmul(a: f32, b: f32) -> f32 {
  return bitcast<f32>(bitcast<u32>(a * b) | um_z);
}

fn um_rem_u(x: u32, y: u32) -> u32 {
  return select(x - (x / y) * y, 0u, y == 0u);
}

fn k_vec4__f32(a_x: f32, a_y: f32, a_z: f32, a_w: f32) -> S_vec4__f32 {
  var u_x_47: f32 = a_x;
  var u_y_48: f32 = a_y;
  var u_z_49: f32 = a_z;
  var u_w_50: f32 = a_w;
  return S_vec4__f32(u_x_47, u_y_48, u_z_49, u_w_50);
}

@compute @workgroup_size(64)
fn um_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let um_i: u32 = gid.y * um_params.row + gid.x;
  if (um_i >= um_params.count) {
    return;
  }
  um_z = um_params.row >> 30u;
  var u_w_4: u32 = um_params.p_w;
  var u_h_5: u32 = um_params.p_h;
  var u_time_6: f32 = um_params.p_time;
  var u_p_7: array<f32, 8> = um_params.p_p;
  var u_c_8: S_vec4__f32 = b_out[um_clamp(um_i, um_params.len_out)];
  var u_a_9: S_vec4__f32 = b_src[um_clamp((um_i + 1u), um_params.len_src)];
  var u_b_10: S_vec4__f32 = b_src2[um_clamp(um_i, um_params.len_src2)];
  b_out[um_clamp(um_i, um_params.len_out)] = k_vec4__f32(um_fmul(u_c_8.f_x, u_p_7[0]), u_a_9.f_y, (u_b_10.f_z + u_time_6), f32(um_rem_u(um_i, u_w_4)));
}
