;; 終わらない fxs_main（時間切れの試験。src/fxs/test_host.um）。
(module
  (memory (export "memory") 1)
  (global $top (mut i32) (i32.const 1024))
  (func (export "fxs_alloc") (param $n i32) (result i32)
    (local $at i32) (local $end i32) (local $pages i32)
    (local.set $at (i32.and (i32.add (global.get $top) (i32.const 15)) (i32.const -16)))
    (local.set $end (i32.add (local.get $at) (local.get $n)))
    (local.set $pages (i32.add (i32.shr_u (local.get $end) (i32.const 16)) (i32.const 1)))
    (if (i32.gt_u (local.get $pages) (memory.size))
      (then
        (if (i32.eq (memory.grow (i32.sub (local.get $pages) (memory.size))) (i32.const -1))
          (then (return (i32.const 0))))))
    (global.set $top (local.get $end))
    (local.get $at))
  (func (export "fxs_main")
    (param i32) (param i32) (param i32) (param i32) (param i32) (param i32)
    (param i32) (param i32) (param i32) (param i32) (param f32) (param $p0 f32) (param $p1 f32) (param $p2 f32) (param $p3 f32) (param $p4 f32) (param $p5 f32) (param $p6 f32) (param $p7 f32)
    (loop $L (br $L))))
