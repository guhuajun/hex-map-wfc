# Godot Addon 迁移文档 — `godot-addon-migration.md`

> 目标：把 `hex-map-wfc`（fork 自 felixturner/hex-map-wfc，当前 WebGPU + Three.js 的六边形 WFC 地图 demo）的 **"动态生成地图"这条 live demo 核心能力** 迁移为一个 Godot addon。
>
> 项目纪律（见项目指令）：**2D + 资源受限 + Opus Magnum 式离散谜题**。只迁 **L0 算法内核 + L1 求解编排**，表现层用 Godot 原生，**不要 1:1 复刻 3D 视觉特效**（水波 RT、PostFX、BatchedMesh 材质等）。
>
> 本文档先**逐行剖析 live demo 动态生成的代码链路**（这是要迁的核心），再给出**分阶段迁移步骤 + 文件映射 + 风险清单**。

---

## 0. 已完成的前置工作（Step 0 逻辑抽取）

为降低移植风险，已先在原 JS 侧做了纯逻辑抽取（详见 `.workbuddy/memory/2026-09-03.md`）：

| 文件 | 角色 | 依赖 |
|---|---|---|
| `src/hexmap/HexWorldModel.js` | 世界级状态 + WFC 编排（`buildPopulateContext` / `runWfcWithRecovery` / `solveAllGrids` / `calculateWorldOffset` / 播种）。**零 Three.js / `?worker` / `App` 依赖**，通过 `host` 适配器与表现层解耦 | 纯算法层 |
| `src/hexmap/HexWFCSolver.js` | 从 `wfc.worker.js` 抽出的 `HexWFCSolver` 类（可 headless 导入，Node 中直接驱动） | 纯算法层 |
| `src/hexmap/HexMap.js` | 改为 `new HexWorldModel(this, params)` + 别名共享状态（`this.globalCells = this.model.globalCells`），并新增 host 适配器 `solveWfcAttempt` / `applyTilesToGrids` | Three.js 表现层 |
| `tools/equiv-test.mjs` | 等价性/确定性验证：50 种子 × 两遍字节一致、`OK`、无异常 → `✅ PASS` | 测试 |

**关键架构（host-sink 模式）**：`HexWorldModel` 持有世界状态与编排逻辑，求解/渲染相关的副作用全部回调给 `host`（即 `HexMap`）：

```
HexWorldModel ──调用──> host.solveWfcAttempt / solveWfcAsync / getFixedCellsForRegion
                      host.getAnchorsForCell / getDefaultTileTypes / applyTilesToGrids
                      host.log / setStatusAsync
```

**这条 `host` 接口，就是 Godot 移植时唯一要重新实现的"接缝"**。算法内核和编排可基本原样复用。

---

## 1. Live Demo 核心能力：动态地图生成 —— 代码剖析

### 1.1 用户在 demo 里能做什么（能力清单）

| 能力 | 触发方式 | 代码入口 |
|---|---|---|
| 启动后仅存在中心占位符 | 自动 | `HexMap.init()` → `createGrid(0,0)`（`HexMap.js:148`） |
| **点空占位符 → 生成该网格** | 鼠标点击占位符 | `HexMapInteraction.onPointerDown` → `grid.onClick` → `onGridClick` |
| **按序逐格展开整张地图**（Modular） | "Build All (Modular)" 按钮 | `autoBuild(order)`（`HexMap.js:732`） |
| **一次性求解整张地图**（Single Solve） | "Build All (Single Solve)" 按钮 | `populateAllGrids()`（`HexMap.js:800`）→ `model.solveAllGrids` |
| **点已生成 tile → 局部重掷 5×5 区域** | Build 模式下点已有格 | `queueRebuildWfc` → `_runRebuildWfc`（`HexMap.js:993`） |
| 清空 / 重新生成 | 按钮 | `reset()` / `regenerateAll()` |
| 实时调参（装饰噪声、水、波、灯光、后处理） | GUI | `GUI.js` |

**核心结论**：live demo 的"动态生成"本质是 **交互式增量展开**——从一个占位符开始，点哪长哪，长完自动冒出相邻占位符，形成 Townscaper 式的生长体验。**这是必须原样保留的体验核心**，不是一次性批量求解。

### 1.2 启动链路（谁先生成了什么）

```
main.js:15            new App(canvas)
  App.init()          (App.js:78)
    ├─ HexMap 创建     this.city = new HexMap(...)        (App.js:118)
    ├─ await city.init()                            (App.js:124)
    │     └─ 只创建中心占位符：await this.createGrid(0,0)  (HexMap.js:148)
    │        → 该 grid 处于 HexGridState.PLACEHOLDER
    ├─ city.startIntroAnimation(...)               (main.js:25)
    │     └─ HexMap.startIntroAnimation() 是空函数   (HexMap.js:1354)
    └─ Pointer 射线回调挂到 city.onPointerDown/Move  (App.js:232-260)
```

⚠️ **重要**：`startIntroAnimation` 是空壳，首次求解**不是自动发生**的。地图的可见生成完全由用户点击驱动（点中心占位符，或点 Build All 按钮）。所以"动态生成"的架构基元是：

> **PLACEHOLDER（空占位符，可点击）→ 点击 → solveWFC → POPULATED（生成格 + 掉落动画）→ 在周围生成新 PLACEHOLDER（带方向三角指示）**

### 1.3 单格生成链路（点占位符的核心路径）

```
HexMapInteraction.onPointerDown(pointer, camera)   (HexMapInteraction.js:207)
  ├─ 射线命中 placeholder clickable
  └─ ownerGrid.onClick()                            (HexMap.js:339, 在 createGrid 内绑定)
        └─ grid._clickQueued = true; placeholder.startSpinning()
            this._enqueueWfc(() => this.onGridClick(grid))   (HexMap.js:344)

_enqueueWfc(fn)                                   (HexMap.js:956)
  └─ 串行化：WFC 队列锁（见 1.7），保证同一时刻只有一个求解

onGridClick(grid)                                 (HexMap.js:698)
  ├─ populateGrid(grid, [], {animate})             (HexMap.js:704)
  │     ├─ model.buildPopulateContext(center, radius, key)  (HexMap.js:383)
  │     │     • 读取本格 radius 范围内的 globalCells 作为 fixedCells
  │     │     • 海洋边界播种 addWaterEdgeSeeds()
  │     │     • 中心/锚点固定查询（host.getFixedCellsForRegion / getAnchorsForCell）
  │     ├─ model.runWfcWithRecovery(ctx)            (HexMap.js:390)
  │     │     • 主求解 → 局部 WFC 恢复 → drop 阶段（见 HexWorldModel）
  │     └─ _applyPopulateResults(grid, ctx, result) (HexMap.js:395 → 409)
  │           • 写 globalCells（addToGlobalCells）
  │           • 处理 changedFixed / dropped / replaced 格
  │           • grid.populateFromCubeResults(...) → 渲染 tile + 掉落动画
  │           • this.onTilesChanged?.(grid.animationDone)  ← 触发水波遮罩重算
  ├─ createAdjacentPlaceholders(gridKey, delay)     (HexMap.js:711)
  │     • 在刚生成的格周围创建空 PLACEHOLDER（带指向已生成邻居的方向三角）
  ├─ pruneInvalidPlaceholders()                     (HexMap.js:714) 越界剪枝
  └─ updateAllPlaceholderTriangles()                (HexMap.js:717) 更新三角指示
```

**这就是"点哪长哪 + 自动冒出邻居占位符"的实现**。迁 Godot 时必须保留：占位符状态机、点击→求解→生成邻居的闭环。

### 1.4 两种"整图生成"模式

**(a) Modular（`autoBuild`，`HexMap.js:732`）** —— 即把 1.3 的 `onGridClick` 按固定顺序串起来：

```js
autoBuild(order)  // order = 19 个 [gridX,gridZ]
  for ([gx,gz] of order) {
    grid = createGrid(gx,gz)            // 不存在则建占位符
    if (grid.state === PLACEHOLDER)
      await onGridClick(grid, {skipPrune:true, animate})
  }
  // 等所有掉落动画结束 → onTilesChanged → 播放 intro 音效
```

特点：**增量求解、格间互相作为 fixedCells 约束、逐个掉落动画**，最贴近 live demo 的"生长感"。

**(b) Single Solve（`populateAllGrids`，`HexMap.js:800`）** —— 一次性批量：

```js
populateAllGrids()
  model.resetWorldState()
  createGrid 所有 19 格（全 PLACEHOLDER）
  model.solveAllGrids(gridSpecs)   // 一次跨全部格的 WFC
  逐格 populateFromCubeResults(...)
```

特点：**无增量约束、单次大求解、速度快但无逐格生长动画**。可视作"快进版"。

### 1.5 局部重掷（rebuild-wfc，点击已生成格）

Build 模式下点一个已生成的 tile，会重掷它周围 5×5 区域（`HexMap.js:993`）：

```
HexMapInteraction.onPointerDown (App.instance.buildMode)
  └─ hm.queueRebuildWfc(globalCubeCoords, global, def)   (HexMapInteraction.js:286)

queueRebuildWfc → _runRebuildWfc                        (HexMap.js:998)
  solveCells = cubeCoordsInRadius(clicked, 2)  ∩ globalCells   // 5×5 区域
  fixedCells = getFixedCellsForRegion(solveCells)        // 区域外圈固定
  result = await solveWfcAsync(solveCells, fixedCells, {maxTries:5})
  if (result.success) {
    applyTileResultsToGrids(result.tiles)
    按 collapseOrder 排序 → 隐藏旧 tile → 逐格 animateTileDrop（错峰 60ms）
    重算装饰 repopulateTilesAt + 掉落
    addToGlobalCells('rebuild-wfc', result.tiles)
    onTilesChanged(animDone)
  }
```

**迁 Godot 时这是"可玩性"亮点**：玩家可以局部改地图而不重算整图。建议保留。

### 1.6 生长动画（让"动态生成"有手感的关键）

动画全部在 `src/hexmap/HexGridAnimation.js`，用 GSAP 驱动，核心数据来自 WFC 的 **`collapseOrder`**（求解时格子被 collapse 的先后顺序）。

```
animatePlacements(grid, collapseOrder, delay, onComplete)  (HexGridAnimation.js:179)
  for i, placement in collapseOrder:        // 按求解顺序逐个掉落
    gsap.delayedCall(delay/1000 * i, step) // 错峰 delay（默认 20ms/格）
    step():
      tile 从 targetY + DROP_HEIGHT(5) 落到 targetY，power1.out，0.4s
      bottomFill 同步拉伸
      tile 掉完 0.4s 后 → animateDecoration 掉落该格上的树/建筑/桥/花等
```

- `DROP_HEIGHT=5`、`ANIM_DURATION=0.4`、`DEC_DELAY=0.4`、`DEC_STAGGER=0.04`（常量见 `HexGridAnimation.js:6-10`）
- `_applyPopulateResults` 里 `animate = options.animate ?? params.roads.animateWFC`（GUI 可关）（`HexMap.js:530`）
- `grid.animationDone` 是一个 Promise，等全部掉落结束，供 `onTilesChanged` 等待水波遮罩重算（`HexMap.js:555`）

**Godot 对应**：用 `Tween` 或 `await get_tree().create_timer(delay)` 实现"按 collapseOrder 错峰掉落"，这是迁移后"手感"的来源，务必保留而非一次性显示。

### 1.7 并发控制（保证动态生成不打架）

动态生成是异步的（WFC 跑在 worker 里），必须有串行化：

| 机制 | 位置 | 作用 |
|---|---|---|
| `_wfcBusy` / `_wfcQueue` / `_drainWfcQueue` / `_releaseWfcLock` | `HexMap.js:956-989` | 单格求解的**串行队列**：同一时刻只跑一个求解，其余排队 |
| `_autoBuilding` | 多处 | 批量构建中，**拒绝**新的占位符点击 / rebuild 请求（`_enqueueWfc` 直接 return，`queueRebuildWfc` 直接 return） |
| `_buildEpoch` / `myEpoch` | `autoBuild` (`HexMap.js:741`) | 新一次 build 会使旧 epoch 的循环**中途退出**（取消竞态） |
| `_buildCancelled` | `populateGrid`/`populateAllGrids` (`HexMap.js:379,802`) | 外部可取消进行中的生成 |
| worker / `WFCManager` | `WFCManager.js` | 真实求解在 Web Worker 线程，主线程不卡 |

**Godot 对应**：用 `Mutex` + `Semaphore` 或简单的"忙标志 + 协程队列"重现这套串行锁；`WorkerThreadPool` 替代 Web Worker。epoch/cancel 机制要原样保留，否则快速连点会出状态错乱。

### 1.8 异步求解桥（WFCManager → Web Worker）

`WFCManager`（`src/hexmap/WFCManager.js`）持有 Web Worker，是主线程不卡死的关键：

```
solveWfcAsync(solveCells, fixedCells, options)   (WFCManager.js:84)
  → postMessage({type:'solve', id, solveCells, fixedCells, options})
  → 返回 Promise，resolve 在 onmessage('result') 时触发   (WFCManager.js:62-75)

worker 消息协议：
  init:  {type:'init', seed}
  solve: {type:'solve', id, solveCells, fixedCells, options}
  result:{type:'result', id, success, tiles, collapseOrder,
          neighborConflict, lastConflict, changedFixedCells,
          unfixedKeys, backtracks, tries}
```

`runWfcAttempt(ctx)`（`HexMap.js:280`）→ `wfcManager.runWfcAttempt(ctx)` 是 `HexWorldModel.host` 调用的求解入口。

**Godot 对应**：`WorkerThreadPool` + `Semaphore` 实现同样的 `init/solve→result` 协议；或（更简单）单格 ~1s 的求解直接在主线程协程里跑（配加载态），待需要时再上线程。

---

## 2. 分层与移植优先级

```
L0 纯算法（必迁，零引擎依赖）
  ├─ SeededRandom.js        Mulberry32 确定性 RNG  ← 移植时绝不能换成 Godot RNG
  ├─ HexWFCCore.js          cube/offset 坐标、邻接方向 CUBE_DIRS、key 工具
  ├─ HexTileData.js         TILE_LIST / HexDir / HexOpposite / LEVELS_COUNT
  ├─ HexWFCSolver.js        ★ 从 worker 抽出的求解器（算法内核，重点）
  └─ HexGridConnector.js    grid 世界偏移 / 全局 cube 坐标换算

L1 求解编排（必迁，host-sink）
  └─ HexWorldModel.js       ★ buildPopulateContext / runWfcWithRecovery / solveAllGrids
                             通过 host 接口回调表现层（Godot 重写 host 即可）

L2 世界状态 + 装饰（按需迁）
  ├─ HexGrid.js             PLACEHOLDER/POPULATED 状态机、instance 管理、replaceTile
  ├─ Decorations.js         noise 聚簇放置（依赖 three SimplexNoise）
  └─ DecorationDefs.js      装饰物类型/层级高度

L3 表现层（Godot 原生重写，不 1:1 复刻）
  ├─ HexTiles.js / HexGridAnimation.js   BatchedMesh + GSAP → MultiMesh + Tween
  ├─ Water.js / WavesMask.js / PostFX.js / Lighting.js   WebGPU 特效 → 视项目纪律可大幅简化/舍弃
  ├─ App.js / GUI.js / index.html        渲染循环 + lil-gui → Godot Control 节点
  └─ HexMapInteraction.js                射线点击 → Godot RayCast / Area3D 信号
```

**迁移纪律**：只做 L0+L1 的 Godot 内核 addon；L3 用 Godot 原生 2D/3D 表现，水波/后处理按"资源受限"原则大幅降配或舍弃。

---

## 3. 分阶段迁移步骤

### Phase 0 — 已完成：JS 侧逻辑抽取 ✅
`HexWorldModel.js` / `HexWFCSolver.js` 抽出，50 种子等价性验证通过。

### Phase 1 — 移植 L0 算法内核（GDScript/C#）
1. 移植 `SeededRandom`（Mulberry32）：**严格 32 位回绕**（`(a * 0x6D2B79F5) & 0xFFFFFFFF`），**禁用** `RandomNumberGenerator`（PCG32，输出不同）。
2. 移植 `HexWFCCore`（坐标换算、CUBE_DIRS）、`HexTileData`（TILE_LIST 等）。
3. 移植 `HexWFCSolver`：
   - 状态用 `Dictionary` 以 `Vector3i` 为 key；
   - `possibilities` 用 `PackedInt64Array` 位集（15 个 int64 = 960 bit ≥ 900 状态），邻接 `byEdge` 预计算成掩码 → propagate 变位与运算（性能关键）；
   - 确定性：求解中调用 RNG 的顺序必须与 JS 完全一致，否则同 seed 不同图。
4. **验证**：写一个 Godot 内 headless 测试，同 seed 跑 `HexWFCSolver` 两次，断言 tile 序列字节一致（对应 JS 侧 `equiv-test.mjs`）。

### Phase 2 — 移植 L1 编排（HexWorldModel + Host 接口）
1. 把 `HexWorldModel` 搬成 Godot 类（`RefCounted` 或 `Node`）。
2. 定义 **Godot Host 接口**（对应 `host.solveWfcAttempt / solveWfcAsync / getFixedCellsForRegion / getAnchorsForCell / getDefaultTileTypes / applyTilesToGrids / log / setStatusAsync`）。Godot 侧可用 `class_name` + 信号/虚方法实现。
3. 移植 `buildPopulateContext` / `runWfcWithRecovery` / `solveAllGrids`，逻辑逐字对应（已通过 JS 侧 50 种子验证，行为已知正确）。

### Phase 3 — 世界状态 + 装饰（L2）
1. `HexGrid` 状态机：PLACEHOLDER / POPULATED、instance 管理、`replaceTile` / `addMountainAt` / `addBridgeAt`。
2. 装饰放置：若需"同 seed 同图"，**必须移植 three 的 SimplexNoise**（Godot 自带 `FastNoiseLite` 输出不同）；否则可用 Godot `Noise` 并接受图不同。

### Phase 4 — 渲染（L3，Godot MultiMesh）
1. `BatchedMesh` → **每类 tile 一个 `MultiMesh`**（约 ~30 draw call，与原 38 同级）。
2. instance 变换：`MultiMesh.set_instance_transform(i, transform)`；层级/颜色用 `instance_color` 或 `custom_data`（对应 `INSTANCE_CUSTOM`）。
3. 占位符：用简化的 `Mesh` + 旋转动画（替代 `startSpinning`）。

### Phase 5 — 交互式动态生成（核心体验）
1. 重写 `HexMapInteraction`：Godot `RayCast3D` / `Area3D` + `input_event` 信号，命中占位符 → 触发生成；命中已生成格（Build 模式）→ 局部重掷。
2. 占位符闭环：`onClick → 串行锁 → onGridClick → populateGrid → applyResults → createAdjacentPlaceholders → prune/updateTriangles`。**这是 live demo 的体验核心，必须保留。**
3. `rebuild-wfc`：点击 5×5 区域重掷（见 1.5）。

### Phase 6 — 生长动画（手感来源）
1. 用 `collapseOrder` 顺序 + 错峰（`await get_tree().create_timer(delay)`）逐格 `Tween` 掉落。
2. 装饰在 tile 掉落后延迟掉落。保留 `animationDone` 信号供水/遮罩重算等待。

### Phase 7 — 异步求解 + 并发锁
1. `WorkerThreadPool` 替代 Web Worker，复刻 `init/solve→result` 协议（`WFCManager`）。
2. 复刻并发控制：`_wfcBusy/_wfcQueue/_drainWfcQueue`、`_autoBuilding`、`_buildEpoch`、`_buildCancelled`（见 1.7）。
3. 先做"主线程协程 + 加载态"也能跑通，再上线程池。

### Phase 8 — 控制面板（GUI）
1. lil-gui 的 `defaultParams`（`GUI.js:13-100`）→ Godot `Resource`/`Dictionary` 参数结构。
2. 用 `Control` 节点（Panel/Button/Slider/OptionButton/ColorPicker）重建：Build All / Clear / 装饰噪声 / 水波 / 灯光 / 调试视图。

### Phase 9 — 验证（对应 JS 侧 PASS 标准）
1. Godot 内 headless 跑 50 种子：同 seed 两次字节一致（确定性）、每格 tile 合法、无异常 → 输出 `✅ PASS`。
2. 对照 JS 侧 `equiv-test.mjs` 的指纹，确认 Godot 与 JS 同 seed 产出一致（跨引擎等价）。

---

## 4. 文件映射表

| 原 JS 文件 | Godot 对应 | 阶段 |
|---|---|---|
| `SeededRandom.js` | `mulberry32.gd`（纯函数） | P1 |
| `HexWFCCore.js` | `hex_wfc_core.gd` | P1 |
| `HexTileData.js` | `hex_tile_data.gd` | P1 |
| `HexWFCSolver.js` | `hex_wfc_solver.gd` | P1 ★ |
| `HexWorldModel.js` | `HexWorldModel.gd` + `Host` 接口 | P2 ★ |
| `WFCManager.js` | `WfcThreadPool.gd`（WorkerThreadPool） | P7 |
| `HexGrid.js` | `HexGrid.gd`（状态机 + MultiMesh） | P3/P4 |
| `HexGridAnimation.js` | `HexGridAnimation.gd`（Tween + collapseOrder） | P6 |
| `Decorations.js` / `DecorationDefs.js` | `Decorations.gd` + noise | P3 |
| `HexMapInteraction.js` | `HexMapInteraction.gd`（RayCast/信号） | P5 |
| `HexMap.js` | `HexMap.gd`（编排 + Host 实现） | P2-P8 |
| `GUI.js` | `Control` UI 场景 + 脚本 | P8 |
| `App.js` / `main.js` / `index.html` | `Main.gd` / 启动场景 | P8 |
| `Water.js` / `WavesMask.js` / `PostFX.js` | （按需大幅简化或舍弃） | — |
| `tools/equiv-test.mjs` | `test/wfc_equiv.gd`（headless） | P1/P9 |

---

## 5. 风险与踩坑清单

1. **确定性（最高优先级）**：必须用 Mulberry32 且严格 32 位回绕；**不能**用 Godot `RandomNumberGenerator`。求解内 RNG 调用顺序须与 JS 一致，否则同 seed 不同图。
2. **数据结构重写**：原 `Map<"q,r,s">` + `Set` 在 Godot 改用 `Dictionary{Vector3i:...}`；状态打包成 int（type*30+rot*5+level）提速；possibilities 用 15×int64 位集 + 位与 propagate。
3. **BatchedMesh → MultiMesh**：需自己管理 instance 计数、显隐、换 mesh；掉落动画改 `set_instance_transform`。
4. **Web Worker → WorkerThreadPool**：消息协议（init/solve→result）要原样复刻；或先主线程协程跑通再上线程。
5. **SimplexNoise 保真**：要"同 seed 同图"必须移植 three 的 SimplexNoise，Godot `FastNoiseLite` 输出不同。
6. **TSL 材质 → ShaderMaterial/StandardMaterial**：层级着色用 instance custom data 传 level。
7. **水波/海岸遮罩（WebGPU RT 管线）**：按"资源受限"纪律**不 1:1 复刻**；海岸距离场可用 CPU BFS 解析算后写 `ImageTexture`，或干脆 stylized 处理。
8. **并发锁不可省**：`_autoBuilding` / `_buildEpoch` / `_buildCancelled` 必须保留，否则快速连点会状态错乱。
9. **动画错峰**：保留"按 collapseOrder 逐格掉落 + 装饰延迟"才像 live demo，不要一次性显示。

---

## 6. 验收标准（迁移完成的定义）

- [ ] Godot 内 `HexWFCSolver` + `HexWorldModel` 同 seed 两次产出字节一致（确定性）。
- [ ] 能从单个占位符开始，**点击增量生成 + 自动冒出邻居占位符**（复刻 live demo 核心体验）。
- [ ] 支持 "Build All (Modular)" 与 "Single Solve" 两种整图生成。
- [ ] 支持点击已生成格的局部 5×5 重掷（rebuild-wfc）。
- [ ] 生长动画按 collapseOrder 错峰掉落，有手感。
- [ ] 50 种子 headless 验证 `✅ PASS`（与 JS 侧指纹一致）。
- [ ] 水波/后处理按 2D+资源受限纪律降配，不拖垮性能。

---

> 附：JS 侧已完成的抽取与 50 种子等价性结论记录在 `.workbuddy/memory/2026-09-03.md`。本迁移文档的代码剖析基于仓库当前 `src/` 状态（`HexWorldModel.js` / `HexWFCSolver.js` 已抽取，`HexMap.js` 已组合使用）。
