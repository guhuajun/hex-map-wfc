/**
 * HexWorldModel — pure world state + WFC orchestration logic.
 *
 * This module is intentionally free of any Three.js / WebGPU / browser-only
 * dependency (no `three`, no `?worker`, no `App`). Everything here operates on
 * plain data and a small `host` adapter that performs the rendering-affecting
 * operations. That keeps the algorithm portable: when migrating to Godot the
 * entire file can be copied as-is (rewriting only the `host` sink against
 * MultiMesh / Resource-based tilesets), and the solver behaviour is preserved.
 *
 * The `host` (HexMap) must provide:
 *   - solveWfcAttempt(ctx)            -> runs one WFC attempt (worker-backed)
 *   - getFixedCellsForRegion(cells)   -> collapsed neighbours for a region
 *   - getAnchorsForCell(fc, s, f)     -> anchor cells for a fixed cell
 *   - getDefaultTileTypes()           -> array of tile type indices
 *   - solveWfcAsync(cells, fixed, opt)-> full solve (used for local/mini WFC)
 *   - applyTilesToGrids(tiles)        -> push solved tiles into visual grids
 *   - log(text, style)                -> status/log sink
 *   - setStatusAsync(text)            -> async status sink
 */

import {
  cubeKey,
  parseCubeKey,
  cubeCoordsInRadius,
  cubeDistance,
  cubeToOffset,
  offsetToCube,
} from './HexWFCCore.js'
import {
  GridDirection,
  getGridWorldOffset,
  worldOffsetToGlobalCube,
} from './HexGridConnector.js'
import { TILE_LIST, TileType } from './HexTileData.js'
import { random } from '../SeededRandom.js'

// Flat-top hex dimensions (must match HexTileGeometry; defaults are the real values)
const HEX_WIDTH = 2
const HEX_HEIGHT = (2 / Math.sqrt(3)) * 2

export class HexWorldModel {
  constructor(host, params = null) {
    this.host = host
    this.params = params

    // ---- Authoritative world state (plain data) ----
    // key: "q,r,s" cube coords, value: { q, r, s, type, rotation, level, gridKey }
    this.globalCells = new Map()

    this.hexGridRadius = 8

    // Debug-tracking sets (read by HexMapDebug / App for label colours)
    this.failedCells = new Set()   // global coords of cells that caused WFC failures
    this.conflictCount = 0
    this.droppedCells = new Set()  // global coords of dropped fixed cells
    this.replacedCells = new Set() // global coords of replaced fixed cells
    this.seededCells = new Set()   // global coords of ocean-seeded cells

    // Which side of the map the water edge / corner ocean seeds land on
    this._waterSideIndex = null
  }

  /**
   * Clear all model-owned world state. Called by HexMap on reset / regenerate /
   * build-all so both HexMap and the model share a clean slate.
   */
  resetWorldState() {
    this.globalCells.clear()
    this.failedCells.clear()
    this.conflictCount = 0
    this.droppedCells.clear()
    this.replacedCells.clear()
    this.seededCells.clear()
    this._waterSideIndex = null
  }

  // ============================================================================
  // Global cell map
  // ============================================================================

  /**
   * Add solved tiles to the global cell map. Overwrites type/rotation/level of
   * existing cells; inserts new ones tagged with their source gridKey.
   * @param {string} gridKey - Grid key for tracking
   * @param {Array} tiles - [{q,r,s,type,rotation,level}] solved tiles
   */
  addToGlobalCells(gridKey, tiles) {
    for (const tile of tiles) {
      const key = cubeKey(tile.q, tile.r, tile.s)
      const existing = this.globalCells.get(key)
      if (existing) {
        existing.type = tile.type
        existing.rotation = tile.rotation
        existing.level = tile.level
      } else {
        this.globalCells.set(key, {
          q: tile.q, r: tile.r, s: tile.s,
          type: tile.type, rotation: tile.rotation, level: tile.level,
          gridKey,
        })
      }
    }
  }

  /** Default tile types for WFC (array of tile-type indices) */
  getDefaultTileTypes() {
    return TILE_LIST.map((_, i) => i)
  }

  // ============================================================================
  // Seeding (ocean / water edge)
  // ============================================================================

  /**
   * Add a single ocean seed at a random corner of the grid.
   * @param {Array} initialCollapses - Array to push water seeds into
   * @param {Object} center - {q,r,s} grid center cube coords
   * @param {number} radius - Grid radius
   */
  addWaterEdgeSeeds(initialCollapses, center, radius) {
    // 6 cube directions
    const dirs = [
      { q: 1, r: -1, s: 0 }, { q: 1, r: 0, s: -1 }, { q: 0, r: 1, s: -1 },
      { q: -1, r: 1, s: 0 }, { q: -1, r: 0, s: 1 }, { q: 0, r: -1, s: 1 },
    ]
    this._waterSideIndex = Math.floor(random() * 6)
    // Midpoint of hex edge between vertex d and vertex (d+1)%6
    const d = dirs[this._waterSideIndex]
    const d2 = dirs[(this._waterSideIndex + 1) % 6]
    const half = Math.floor(radius / 2)
    const q = center.q + d.q * (radius - half) + d2.q * half
    const r = center.r + d.r * (radius - half) + d2.r * half
    const s = center.s + d.s * (radius - half) + d2.s * half
    initialCollapses.push({ q, r, s, type: TileType.WATER, rotation: 0, level: 0 })
  }

  /**
   * Get ocean seeds at the center of 3 contiguous ring-2 grids on one side of
   * the map. Uses the same side direction as the first grid's water edge seed.
   */
  getMapCornerOceanSeeds() {
    const cubeDirs = [
      { q: 1, r: -1, s: 0 },  { q: 1, r: 0, s: -1 },
      { q: 0, r: 1, s: -1 },  { q: -1, r: 1, s: 0 },
      { q: -1, r: 0, s: 1 },  { q: 0, r: -1, s: 1 },
    ]
    // Grid-cube to grid-offset conversion
    const gridCubeToOffset = (q, r) => [q, r + Math.floor((q - (q & 1)) / 2)]

    // Use same side as first grid's water seed (or pick one for Build All)
    const d = this._waterSideIndex ?? Math.floor(random() * 6)
    this._waterSideIndex = d

    // Vertex grid (ring-2) in direction d, plus its two ring neighbors
    const dir = cubeDirs[d]
    const prevStep = cubeDirs[(d + 4) % 6]
    const nextStep = cubeDirs[(d + 2) % 6]
    const sideGrids = [
      gridCubeToOffset(dir.q * 2 + prevStep.q, dir.r * 2 + prevStep.r),
      gridCubeToOffset(dir.q * 2, dir.r * 2),
      gridCubeToOffset(dir.q * 2 + nextStep.q, dir.r * 2 + nextStep.r),
    ]

    // Also seed the ring-1 grid in the same direction
    const innerGrid = gridCubeToOffset(dir.q, dir.r)

    const seeds = []
    for (const [gx, gz] of [...sideGrids, innerGrid]) {
      const worldOffset = this.calculateWorldOffset(gx, gz)
      const c = worldOffsetToGlobalCube(worldOffset)
      seeds.push({ q: c.q, r: c.r, s: c.s, type: TileType.WATER, rotation: 0, level: 0 })
    }
    return seeds
  }

  // ============================================================================
  // Grid world offset (pure geometry — no TileGeometry dependency)
  // ============================================================================

  /**
   * Calculate world offset for grid coordinates.
   * Traverses from origin using getGridWorldOffset for consistency.
   */
  calculateWorldOffset(gridX, gridZ) {
    if (gridX === 0 && gridZ === 0) {
      return { x: 0, z: 0 }
    }

    const hexWidth = HEX_WIDTH
    const hexHeight = HEX_HEIGHT

    // Traverse from (0,0) to (gridX, gridZ) using flat-top hex directions
    let totalX = 0
    let totalZ = 0
    let currentX = 0
    let currentZ = 0

    while (currentX !== gridX || currentZ !== gridZ) {
      const dx = gridX - currentX
      const dz = gridZ - currentZ
      const isOddCol = Math.abs(currentX) % 2 === 1

      let direction = null
      let nextX = currentX
      let nextZ = currentZ

      // For flat-top hex, pick direction based on where we need to go
      // N/S for vertical, NE/SE/SW/NW for diagonal
      if (dx === 0) {
        // Pure vertical movement
        if (dz < 0) {
          direction = GridDirection.N
          nextZ -= 1
        } else {
          direction = GridDirection.S
          nextZ += 1
        }
      } else if (dx > 0) {
        // Need to go right (positive x)
        if (dz < 0 || (dz === 0 && !isOddCol)) {
          direction = GridDirection.NE
          nextX += 1
          nextZ += isOddCol ? 0 : -1
        } else {
          direction = GridDirection.SE
          nextX += 1
          nextZ += isOddCol ? 1 : 0
        }
      } else {
        // Need to go left (negative x)
        if (dz < 0 || (dz === 0 && !isOddCol)) {
          direction = GridDirection.NW
          nextX -= 1
          nextZ += isOddCol ? 0 : -1
        } else {
          direction = GridDirection.SW
          nextX -= 1
          nextZ += isOddCol ? 1 : 0
        }
      }

      if (direction !== null) {
        const offset = getGridWorldOffset(this.hexGridRadius, direction, hexWidth, hexHeight)
        totalX += offset.x
        totalZ += offset.z
        currentX = nextX
        currentZ = nextZ
      }

      // Safety check
      if (Math.abs(currentX) > 100 || Math.abs(currentZ) > 100) {
        console.warn('calculateWorldOffset: loop limit reached')
        break
      }
    }

    return { x: totalX, z: totalZ }
  }

  // ============================================================================
  // Populate context
  // ============================================================================

  /**
   * Build the context object used by runWfcWithRecovery and the result
   * application step. Pure data computation; only seeding (random) and the host
   * fixed-cell / anchor queries touch the outside world.
   * @param {Object} centerCube - {q,r,s} grid center cube coords
   * @param {number} radius - Grid radius
   * @param {string} gridKey - "x,z" grid key
   * @param {Object} options - { initialCollapses, weights }
   * @returns {Object} populate context (plain data)
   */
  buildPopulateContext(centerCube, radius, gridKey, options = {}) {
    const center = centerCube
    const solveCells = cubeCoordsInRadius(center.q, center.r, center.s, radius)
    const fixedCells = this.host.getFixedCellsForRegion(solveCells)

    const initialCollapses = options.initialCollapses ?? []
    if (fixedCells.length === 0 && initialCollapses.length === 0) {
      initialCollapses.push({ q: center.q, r: center.r, s: center.s, type: TileType.GRASS, rotation: 0, level: 0 })
      this.addWaterEdgeSeeds(initialCollapses, center, radius)
    }

    // Seed ocean at map corners that fall within this grid
    const solveSet = new Set(solveCells.map(c => cubeKey(c.q, c.r, c.s)))
    const fixedSet = new Set(fixedCells.map(fc => cubeKey(fc.q, fc.r, fc.s)))
    for (const seed of this.getMapCornerOceanSeeds()) {
      const key = cubeKey(seed.q, seed.r, seed.s)
      if (solveSet.has(key) && !fixedSet.has(key)) {
        initialCollapses.push(seed)
      }
    }

    // Track seeded cells for debug labels
    for (const ic of initialCollapses) {
      const co = cubeToOffset(ic.q, ic.r, ic.s)
      this.seededCells.add(`${co.col},${co.row}`)
    }

    const tileTypes = this.host.getDefaultTileTypes()
    const anchorMap = new Map()
    for (const fc of fixedCells) {
      anchorMap.set(cubeKey(fc.q, fc.r, fc.s), this.host.getAnchorsForCell(fc, solveSet, fixedSet))
    }

    return {
      gridKey, center, solveCells, fixedCells, initialCollapses, tileTypes,
      anchorMap,
      persistedUnfixedKeys: new Set(),
      persistedUnfixedOriginals: new Map(),
      initialFixedCount: fixedCells.length,
      attempt: 0,
      options,
    }
  }

  /**
   * Track WFC failure info (add to failedCells, count conflicts)
   */
  trackFailure(gridKey, wfcResult) {
    this.conflictCount++
    if (wfcResult.neighborConflict) {
      const c = wfcResult.neighborConflict
      this.failedCells.add(`${c.failedCol},${c.failedRow}`)
    }
  }

  // ============================================================================
  // WFC with recovery
  // ============================================================================

  /**
   * Run WFC with recovery: initial attempt → local-WFC → drop.
   * Algorithm + world-state mutations live here; the rendering-affecting
   * operations are delegated to `host` via the sink interface.
   * @param {Object} ctx - Populate context from buildPopulateContext
   * @returns {{ result, resultCollapseOrder, changedFixedCells, unfixedKeys, droppedFixedCubes, stats }}
   */
  async runWfcWithRecovery(ctx) {
    const stats = { postDroppedCount: 0, localWfcAttempts: 0, backtracks: 0, tries: 0 }
    const droppedFixedCubes = []
    let result = null
    let resultCollapseOrder = []
    let changedFixedCells = []
    let unfixedKeys = []

    // Phase 0: Initial attempt (solver handles neighbor cell unfixing internally)
    const initialResult = await this.host.solveWfcAttempt(ctx)
    if (initialResult.success) {
      result = initialResult.tiles
      resultCollapseOrder = initialResult.collapseOrder
      changedFixedCells = initialResult.changedFixedCells || []
      unfixedKeys = initialResult.unfixedKeys || []
      stats.backtracks += initialResult.backtracks || 0
      stats.tries += initialResult.tries || 0

    } else {
      stats.backtracks += initialResult.backtracks || 0
      stats.tries += initialResult.tries || 0

      this.trackFailure(ctx.gridKey, initialResult)
      let failedCell = initialResult.failedCell
      let isNeighborConflict = initialResult.isNeighborConflict
      let sourceKey = initialResult.sourceKey

      // Local-WFC recovery: resolve neighbor regions around the failure
      const maxLocalAttempts = 5
      const resolvedRegions = new Set()
      let localAttempts = 0

      while (!result && localAttempts < maxLocalAttempts) {
        if (!failedCell) break

        // Pick center: sourceKey first if neighbor conflict, then nearest fixed cell
        let centerQ, centerR, centerS
        if (localAttempts === 0 && isNeighborConflict && sourceKey) {
          ;({ q: centerQ, r: centerR, s: centerS } = parseCubeKey(sourceKey))
          resolvedRegions.add(sourceKey)
        } else {
          const candidates = ctx.fixedCells.filter(fc =>
            !fc.dropped && !resolvedRegions.has(cubeKey(fc.q, fc.r, fc.s))
          )
          if (candidates.length === 0) break
          candidates.sort((a, b) =>
            cubeDistance(a.q, a.r, a.s, failedCell.q, failedCell.r, failedCell.s) -
            cubeDistance(b.q, b.r, b.s, failedCell.q, failedCell.r, failedCell.s)
          )
          centerQ = candidates[0].q; centerR = candidates[0].r; centerS = candidates[0].s
          resolvedRegions.add(cubeKey(centerQ, centerR, centerS))
        }

        localAttempts++
        stats.localWfcAttempts++
        const co = cubeToOffset(centerQ, centerR, centerS)
        this.host.log(`[${ctx.gridKey}] Local-WFC resolving around (${co.col},${co.row})`, 'color: blue')

        // Mini-WFC on radius-2 region
        const localSolveCells = cubeCoordsInRadius(centerQ, centerR, centerS, 2)
          .filter(c => this.globalCells.has(cubeKey(c.q, c.r, c.s)))
        const localFixedCells = this.host.getFixedCellsForRegion(localSolveCells)
        const localResult = await this.host.solveWfcAsync(localSolveCells, localFixedCells, {
          tileTypes: ctx.tileTypes, maxTries: 5, quiet: true,
        })

        if (!localResult.success || !localResult.tiles) {
          this.host.log(`[${ctx.gridKey}] Local-WFC failed`, 'color: red')
          continue
        }

        // Apply local results to neighbor grids
        this.host.applyTilesToGrids(localResult.tiles)
        this.addToGlobalCells('local-wfc', localResult.tiles)
        this.host.log(`[${ctx.gridKey}] Local-WFC re-solved ${localResult.tiles.length} cells`, 'color: blue')

        // Rebuild context from updated globalCells
        ctx.fixedCells = this.host.getFixedCellsForRegion(ctx.solveCells)
        const newSolveSet = new Set(ctx.solveCells.map(c => cubeKey(c.q, c.r, c.s)))
        const newFixedSet = new Set(ctx.fixedCells.map(fc => cubeKey(fc.q, fc.r, fc.s)))
        ctx.anchorMap.clear()
        for (const fc of ctx.fixedCells) {
          ctx.anchorMap.set(cubeKey(fc.q, fc.r, fc.s), this.host.getAnchorsForCell(fc, newSolveSet, newFixedSet))
        }
        ctx.persistedUnfixedKeys.clear()
        ctx.persistedUnfixedOriginals.clear()

        // Retry main grid WFC
        const retryResult = await this.host.solveWfcAttempt(ctx)
        if (retryResult.success) {
          result = retryResult.tiles
          resultCollapseOrder = retryResult.collapseOrder
          changedFixedCells = retryResult.changedFixedCells || []
          unfixedKeys = retryResult.unfixedKeys || []
          stats.backtracks += retryResult.backtracks || 0
          stats.tries += retryResult.tries || 0
          break
        }

        stats.backtracks += retryResult.backtracks || 0
        stats.tries += retryResult.tries || 0
        this.trackFailure(ctx.gridKey, retryResult)
        failedCell = retryResult.failedCell
        isNeighborConflict = retryResult.isNeighborConflict
        sourceKey = retryResult.sourceKey
      }

      // Drop phase: Drop fixed cells one by one, sorted by proximity to failed cell
      // Clear persisted-unfixed state — their anchors create undroppable constraints
      ctx.persistedUnfixedKeys.clear()
      ctx.persistedUnfixedOriginals.clear()
      while (!result) {
        const dropCandidates = ctx.fixedCells.filter(fc => !fc.dropped)
        if (dropCandidates.length === 0) break

        if (failedCell) {
          dropCandidates.sort((a, b) => {
            const distA = cubeDistance(a.q, a.r, a.s, failedCell.q, failedCell.r, failedCell.s)
            const distB = cubeDistance(b.q, b.r, b.s, failedCell.q, failedCell.r, failedCell.s)
            return distA - distB
          })
        }

        const fcToDrop = dropCandidates[0]
        const co = cubeToOffset(fcToDrop.q, fcToDrop.r, fcToDrop.s)
        this.droppedCells.add(`${co.col},${co.row}`)
        droppedFixedCubes.push({ q: fcToDrop.q, r: fcToDrop.r, s: fcToDrop.s })
        fcToDrop.dropped = true
        stats.postDroppedCount++
        const tileName = TILE_LIST[fcToDrop.type]?.name ?? fcToDrop.type
        this.host.log(`[${ctx.gridKey}] Dropped (${co.col},${co.row}) ${tileName}`, 'color: red')

        const wfcResult = await this.host.solveWfcAttempt(ctx)
        if (wfcResult.success) {
          result = wfcResult.tiles
          resultCollapseOrder = wfcResult.collapseOrder
          changedFixedCells = wfcResult.changedFixedCells || []
          unfixedKeys = wfcResult.unfixedKeys || []
          stats.backtracks += wfcResult.backtracks || 0
          stats.tries += wfcResult.tries || 0

        } else {
          stats.backtracks += wfcResult.backtracks || 0
          stats.tries += wfcResult.tries || 0

          this.trackFailure(ctx.gridKey, wfcResult)
          if (wfcResult.failedCell) failedCell = wfcResult.failedCell
        }
      }
    }

    return { result, resultCollapseOrder, changedFixedCells, unfixedKeys, droppedFixedCubes, stats }
  }

  // ============================================================================
  // Build-all (single pass over every grid)
  // ============================================================================

  /**
   * Solve the entire map in a single WFC pass (no fixed cells between grids).
   * Pure data: collects all solve cells, seeds initial collapses, runs one
   * solve, then partitions the result per grid. The host performs the actual
   * full-map solve via its worker.
   * @param {Array} gridSpecs - [{ key, centerCube, radius }]
   * @param {Object} options - { weights }
   * @returns {Promise<{success, tiles, collapseOrder, perGrid, totalCells, backtracks, tries}>}
   */
  async solveAllGrids(gridSpecs, options = {}) {
    // ---- Collect all solve cells (deduplicated) ----
    const solveKeySet = new Set()
    const allSolveCells = []
    for (const spec of gridSpecs) {
      const cells = cubeCoordsInRadius(
        spec.centerCube.q, spec.centerCube.r, spec.centerCube.s, spec.radius
      )
      for (const c of cells) {
        const ck = cubeKey(c.q, c.r, c.s)
        if (!solveKeySet.has(ck)) {
          solveKeySet.add(ck)
          allSolveCells.push(c)
        }
      }
    }

    const totalCells = allSolveCells.length

    // ---- Seed initial collapses ----
    const centerSpec = gridSpecs.find(s => s.key === '0,0') || gridSpecs[0]
    const centerCube = centerSpec.centerCube
    const initialCollapses = [
      { q: centerCube.q, r: centerCube.r, s: centerCube.s, type: TileType.GRASS, rotation: 0, level: 0 },
      ...this.getMapCornerOceanSeeds(),
    ]

    // Track seeded cells for debug labels
    for (const ic of initialCollapses) {
      const co = cubeToOffset(ic.q, ic.r, ic.s)
      this.seededCells.add(`${co.col},${co.row}`)
    }

    // ---- Single WFC solve (no fixed cells) ----
    const tileTypes = this.getDefaultTileTypes()
    const result = await this.host.solveWfcAsync(allSolveCells, [], {
      tileTypes,
      weights: options.weights ?? {},
      maxTries: 5,
      initialCollapses,
      gridId: 'BUILD_ALL',
      attemptNum: 1,
    })

    if (!result.success) {
      return { success: false, totalCells, backtracks: result.backtracks || 0, tries: result.tries || 0 }
    }

    // ---- Build lookup map from results ----
    const tileMap = new Map()
    for (const tile of result.tiles) {
      tileMap.set(cubeKey(tile.q, tile.r, tile.s), tile)
    }

    // ---- Partition results to each grid ----
    const perGrid = new Map()
    for (const spec of gridSpecs) {
      const center = spec.centerCube
      const gridCells = cubeCoordsInRadius(center.q, center.r, center.s, spec.radius)

      const gridTiles = []
      for (const c of gridCells) {
        const tile = tileMap.get(cubeKey(c.q, c.r, c.s))
        if (tile) gridTiles.push(tile)
      }

      let gridCollapseOrder = []
      if (result.collapseOrder) {
        const gridCellKeys = new Set(gridCells.map(c => cubeKey(c.q, c.r, c.s)))
        for (const c of result.collapseOrder) {
          if (gridCellKeys.has(cubeKey(c.q, c.r, c.s))) gridCollapseOrder.push(c)
        }
      }

      perGrid.set(spec.key, { tiles: gridTiles, collapseOrder: gridCollapseOrder })
    }

    return {
      success: true,
      tiles: result.tiles,
      collapseOrder: result.collapseOrder,
      perGrid,
      totalCells,
      backtracks: result.backtracks || 0,
      tries: result.tries || 0,
    }
  }
}
