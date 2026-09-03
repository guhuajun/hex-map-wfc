import {
  Object3D,
  MeshPhysicalNodeMaterial,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Mesh,
  MeshStandardMaterial,
  TextureLoader,
  SRGBColorSpace,
} from 'three/webgpu'
import { uniform, varyingProperty, materialColor, diffuseColor, materialOpacity, vec3, vec4, texture, uv, mix, select, positionGeometry, float, clamp } from 'three/tsl'
import { cubeKey, parseCubeKey, cubeCoordsInRadius, cubeDistance, offsetToCube, cubeToOffset, localToGlobalCoords, globalToLocalGrid } from './HexWFCCore.js'
import { WFCManager } from './WFCManager.js'
import { HexWorldModel } from './HexWorldModel.js'
import { HexMapDebug } from './HexMapDebug.js'
import { HexMapInteraction } from './HexMapInteraction.js'
import { setStatus, setStatusAsync, log, App } from '../App.js'
import { TILE_LIST, TileType, LEVELS_COUNT } from './HexTileData.js'
import { HexTileGeometry } from './HexTiles.js'
import { HexGrid, HexGridState } from './HexGrid.js'
import {
  GridDirection,
  getGridKey,
  parseGridKey,
  getAdjacentGridKey,
  getGridWorldOffset,
  worldOffsetToGlobalCube,
} from './HexGridConnector.js'
import { initGlobalTreeNoise, rebuildNoiseTables, Decorations } from './Decorations.js'
import { Water } from './effects/Water.js'
import { random, setSeed } from '../SeededRandom.js'
import { Sounds } from '../lib/Sounds.js'

const LEVEL_HEIGHT = 0.5
const TILE_SURFACE = 1

/**
 * Get all grid coordinates within the hex radius (19 grids at radius 2)
 * Returns [q, gz] pairs in flat-top hex odd-q offset layout
 */
function getAllGridCoordinates(cubeRadius = 2) {
  const coords = []
  for (let q = -cubeRadius; q <= cubeRadius; q++) {
    for (let r = -cubeRadius; r <= cubeRadius; r++) {
      const s = -q - r
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(s)) <= cubeRadius) {
        const gz = r + Math.floor((q - (q & 1)) / 2)
        coords.push([q, gz])
      }
    }
  }
  return coords
}

/**
 * HexMap - Manages the entire world of multiple HexGrid instances
 *
 * Handles:
 * - Creating and managing multiple HexGrid instances
 * - Grid expansion via placeholder clicks
 * - Shared resources (WFC rules, material)
 *
 * Grids can be in two states:
 * - PLACEHOLDER: Shows clickable button, no tiles yet
 * - POPULATED: Has tiles, shows debug helper when enabled
 */
export class HexMap {
  constructor(scene, params) {
    this.scene = scene
    this.params = params

    // Grid management - all grids (both PLACEHOLDER and POPULATED)
    this.grids = new Map()  // key: "x,z" grid coords, value: HexGrid instance
    this.roadMaterial = null

    // World model: owns authoritative world state + WFC orchestration logic.
    // Kept free of Three.js so the algorithm can be ported cleanly (Godot addon).
    this.model = new HexWorldModel(this, params)
    // Alias model-owned state onto HexMap so existing consumers
    // (App, HexMapInteraction, HexMapDebug) keep working unchanged.
    this.globalCells = this.model.globalCells
    this.hexGridRadius = this.model.hexGridRadius
    this.failedCells = this.model.failedCells
    this.droppedCells = this.model.droppedCells
    this.replacedCells = this.model.replacedCells
    this.seededCells = this.model.seededCells

    // Status/log sinks (model routes through these instead of importing App)
    this.log = log
    this.setStatusAsync = setStatusAsync



    // Global cell map — all collapsed cells across all grids
    // key: "q,r,s" cube coords, value: { q, r, s, type, rotation, level, gridKey }
    this.globalCells = new Map()

    // WFC solver (owns worker, rules, and cell helpers)
    this.wfcManager = new WFCManager(this.model.globalCells)

    // Debug tile labels
    this.tileLabels = new Object3D()
    this.tileLabels.visible = false
    this.tileLabelMode = 'coords'
    // failedCells / conflictCount / droppedCells / replacedCells / seededCells
    // are now owned by this.model and aliased above.

    // Interaction (hover, pointer events)
    this.interaction = new HexMapInteraction(this)

    // Debug/display manager
    this.debug = new HexMapDebug(this)

    // Helper visibility state
    this.helpersVisible = false
    this.axesHelpersVisible = false

    // Regeneration state (prevents overlay rendering during disposal)
    this.isRegenerating = false
    this._buildCancelled = false
    this._buildEpoch = 0

    // WFC solve queue (prevents concurrent solves)
    this._wfcBusy = false
    this._wfcQueue = []
    this._wfcIdleResolve = null
    this._autoBuilding = false

    // Convenience alias
    this.hexWfcRules = null
  }

  async init() {
    await HexTileGeometry.init('./assets/models/hex-terrain.glb')
    Decorations.initGeometries(HexTileGeometry.gltfScene)
    this.createFloor()
    this.water = new Water(this.scene, this.coastMaskTexture, this.coveMaskTexture)
    this.water.init()
    await this.initMaterial()
    this.initWfcRules()
    this.initWfcWorker()
    initGlobalTreeNoise()  // Initialize shared noise for tree placement

    // Hover highlight for click-to-solve region
    this.interaction.initHoverHighlight()

    // Create only the center placeholder — others created dynamically on demand
    await this.createGrid(0, 0)

    this.scene.add(this.tileLabels)
  }

  /**
   * Initialize shared material
   */
  async initMaterial() {
    if (!HexTileGeometry.loaded || HexTileGeometry.geoms.size === 0) {
      console.warn('HexTileGeometry not loaded')
      return
    }

    const mat = new MeshPhysicalNodeMaterial()
    mat.roughness = 1
    mat.metalness = 0
    this.roadMaterial = mat

    // Override setupDiffuseColor to skip the automatic batchColor multiply.
    // We read vBatchColor ourselves in the colorNode for level data, not as a tint.
    this.roadMaterial.setupDiffuseColor = function(builder) {
      const colorNode = this.colorNode ? vec4(this.colorNode) : materialColor
      diffuseColor.assign(colorNode)
      const opacityNode = this.opacityNode ? float(this.opacityNode) : materialOpacity
      diffuseColor.a.assign(diffuseColor.a.mul(opacityNode))
    }

    // Load season textures and set up noise-blended colorNode
    await this._initTextureBlend()

    this.roadMaterial.colorNode = this._combinedColor
  }

  /**
   * Load season textures and build the TSL blend node
   */
  async _initTextureBlend() {
    // Load both season textures
    const loader = new TextureLoader()
    const loadTex = (path) => new Promise((resolve) => {
      loader.load(path, (tex) => {
        tex.flipY = false  // GLB geometry UVs expect non-flipped textures
        tex.colorSpace = SRGBColorSpace
        tex.needsUpdate = true
        resolve(tex)
      })
    })

    // Load mask texture (linear, not sRGB — it's a data mask)
    const loadMask = (path) => new Promise((resolve) => {
      loader.load(path, (tex) => {
        tex.flipY = false
        tex.needsUpdate = true
        resolve(tex)
      })
    })

    const [texA, texB, texMask] = await Promise.all([
      loadTex('./assets/textures/moody.png'),
      loadTex('./assets/textures/winter.png'),
      loadMask('./assets/textures/water-mask.png'),
    ])

    this._texA = texA
    this._texB = texB

    // Sample both textures at the same UVs (store nodes for runtime swapping)
    const texCoord = uv()
    this._texNodeA = texture(texA, texCoord)
    this._texNodeB = texture(texB, texCoord)
    this._texNodeMask = texture(texMask, texCoord)
    const sampleA = this._texNodeA
    const sampleB = this._texNodeB

    // Tile level stored in instance color R channel (0 at level 0, 1 at max level)
    // G channel flags decorations (G=1) vs tiles (G=0) to skip slope contribution
    // setupDiffuseColor override prevents auto-multiply, so this is pure data
    const batchColor = varyingProperty('vec3', 'vBatchColor')
    const levelBlend = batchColor.r
    const isDecoration = batchColor.g.greaterThan(0.5)
    // Raw geometry Y (before batch transform) for slope gradient
    // Tile surface is at geomY=1.0, each 0.5u above = +1 level
    // So slope contribution = (geomY - 1.0) / 0.5 / (LEVELS_COUNT - 1)
    const rawGeomPos = positionGeometry.toVarying('vRawGeomPos')
    const slopeContrib = select(isDecoration,
      rawGeomPos.y.mul(2.0 / (LEVELS_COUNT - 1)),          // decorations: geom starts at y=0
      rawGeomPos.y.sub(1.0).mul(2.0 / (LEVELS_COUNT - 1))  // tiles: surface at y=1.0
    )
    // Level bias shifts the blend ramp up or down (-1 to 1)
    this._levelBias = uniform(0)
    const blendFactor = clamp(levelBlend.add(slopeContrib).add(this._levelBias), 0, 1)

    // Blended season textures (normal mode)
    const blendedColor = mix(sampleA, sampleB, blendFactor)

    // Debug HSL gradient (level colors mode): hue 0 (red) → 250/360 (blue)
    const hue = clamp(mix(float(100.0 / 360.0), float(360.0 / 360.0), blendFactor), 0, 1)
    const h6 = hue.mul(6.0)
    const hslR = clamp(h6.sub(3.0).abs().sub(1.0), 0, 1)
    const hslG = clamp(float(2.0).sub(h6.sub(2.0).abs()), 0, 1)
    const hslB = clamp(float(2.0).sub(h6.sub(4.0).abs()), 0, 1)
    const debugColor = vec3(hslR, hslG, hslB).mul(0.8)

    // Mode uniform: 0 = normal (blended textures), 1 = debug HSL, 2 = white
    this._colorMode = uniform(0)
    const isDebug = this._colorMode.equal(1)
    const isWhite = this._colorMode.equal(2)
    this._combinedColor = select(isWhite, vec3(1, 1, 1), select(isDebug, debugColor, blendedColor))

    // Unlit water mask material (for per-frame mask RT render — no PBR overhead)
    this.waterMaskMaterial = new MeshBasicNodeMaterial()
    this.waterMaskMaterial.colorNode = vec3(this._texNodeMask.r)
    // Skip batchColor multiply (R channel encodes level, not a tint)
    this.waterMaskMaterial.setupDiffuseColor = this.roadMaterial.setupDiffuseColor

    this.roadMaterial.needsUpdate = true
  }

  // ---- WFCManager delegators ----
  initWfcRules() { this.wfcManager.initWfcRules(); this.hexWfcRules = this.wfcManager.hexWfcRules }
  initWfcWorker() { this.wfcManager.initWfcWorker() }
  solveWfcAsync(solveCells, fixedCells, options) { return this.wfcManager.solveWfcAsync(solveCells, fixedCells, options) }
  addToGlobalCells(gridKey, tiles) { this.wfcManager.addToGlobalCells(gridKey, tiles) }
  getFixedCellsForRegion(solveCells) { return this.wfcManager.getFixedCellsForRegion(solveCells) }
  getAnchorsForCell(fc, solveSet, fixedSet) { return this.wfcManager.getAnchorsForCell(fc, solveSet, fixedSet) }
  getDefaultTileTypes() { return this.wfcManager.getDefaultTileTypes() }

  // ---- Host sink for HexWorldModel ----
  // These adapt the world model's pure-logic requests to the actual WFC solver
  // and the renderer. They are the exact seam to reimplement when porting the
  // model to Godot (MultiMesh / Resource-based tilesets).
  solveWfcAttempt(ctx) { return this.wfcManager.runWfcAttempt(ctx) }
  applyTilesToGrids(tiles) { return this.applyTileResultsToGrids(tiles) }

  /** Apply WFC tile results to their source grids (replace tiles + collect changed tiles per grid) */
  applyTileResultsToGrids(tiles) {
    const changedTilesPerGrid = new Map()
    for (const t of tiles) {
      const key = cubeKey(t.q, t.r, t.s)
      const existing = this.globalCells.get(key)
      if (!existing) continue
      const sourceGrid = this.grids.get(existing.gridKey)
      if (!sourceGrid) continue
      const { gridX, gridZ } = globalToLocalGrid(t, sourceGrid.globalCenterCube, sourceGrid.gridRadius)
      sourceGrid.replaceTile(gridX, gridZ, t.type, t.rotation, t.level)
      const replacedTile = sourceGrid.hexGrid[gridX]?.[gridZ]
      if (replacedTile) {
        if (!changedTilesPerGrid.has(sourceGrid)) changedTilesPerGrid.set(sourceGrid, [])
        changedTilesPerGrid.get(sourceGrid).push(replacedTile)
      }
    }
    return changedTilesPerGrid
  }

  createFloor() {
    const floorGeometry = new PlaneGeometry(296, 296)
    floorGeometry.rotateX(-Math.PI / 2)

    const floorMaterial = new MeshStandardMaterial({
      color: 0x999999,
      roughness: 0.9,
      metalness: 0.0,
    })

    this.floor = new Mesh(floorGeometry, floorMaterial)
    this.floor.receiveShadow = true
    this.scene.add(this.floor)
  }

  /**
   * Create a new HexGrid at grid coordinates (starts in PLACEHOLDER state)
   * @param {number} gridX - Grid X coordinate
   * @param {number} gridZ - Grid Z coordinate
   * @returns {HexGrid} The created grid
   */
  async createGrid(gridX, gridZ, { hidden = false } = {}) {
    const key = getGridKey(gridX, gridZ)
    if (this.grids.has(key)) {
      console.warn(`Grid already exists at ${key}`)
      return this.grids.get(key)
    }

    // Calculate world offset and global cube center
    const worldOffset = this.calculateWorldOffset(gridX, gridZ)
    const globalCenterCube = worldOffsetToGlobalCube(worldOffset)

    // Create grid in PLACEHOLDER state
    const grid = new HexGrid(this.scene, this.roadMaterial, this.hexGridRadius, worldOffset)
    grid.gridCoords = { x: gridX, z: gridZ }
    grid.globalCenterCube = globalCenterCube
    grid.onClick = () => {
      if (this._autoBuilding) return
      if (grid._clickQueued) return  // already queued, ignore duplicate clicks
      grid._clickQueued = true
      grid.placeholder?.startSpinning()
      this._enqueueWfc(() => this.onGridClick(grid))
    }

    await grid.init(null, { hidden })  // Placeholder only — meshes init lazily or in batch

    // Apply current axes helper visibility
    if (grid.axesHelper) {
      grid.axesHelper.visible = this.axesHelpersVisible
    }

    // Apply current grid label visibility
    grid.setGridLabelVisible(this.tileLabels.visible)

    this.grids.set(key, grid)

    // Set triangle indicators for populated neighbors
    const neighborDirs = this.getPopulatedNeighborDirections(key)
    grid.setPlaceholderNeighbors(neighborDirs)

    return grid
  }

  /**
   * Populate a grid using global cube coordinates.
   * Orchestrates setup → WFC solve with recovery → result application.
   * @param {HexGrid} grid - Grid to populate
   * @param {Array} seedTiles - Unused (kept for API compatibility)
   * @param {Object} options - { animate, animateDelay, initialCollapses, weights }
   */
  async populateGrid(grid, seedTiles = [], options = {}) {
    if (grid.state === HexGridState.POPULATED) {
      console.warn('Grid already populated')
      return
    }

    this._buildCancelled = false
    this.onBeforeTilesChanged?.()

    const center = grid.globalCenterCube
    const ctx = this.model.buildPopulateContext(
      center, this.hexGridRadius, getGridKey(grid.gridCoords.x, grid.gridCoords.z), options
    )
    log(`[${ctx.gridKey}] POPULATING GRID (${ctx.initialFixedCount} neighbors)`, 'color: blue')
    await setStatusAsync(`[${ctx.gridKey}] Solving WFC...`)

    grid.placeholder?.startSpinning()
    const solveResult = await this.model.runWfcWithRecovery(ctx)
    grid.placeholder?.stopSpinning()

    if (this._buildCancelled) return

    return this._applyPopulateResults(grid, ctx, solveResult, options)
  }

  // ---- Thin delegators to HexWorldModel (kept for API compatibility) ----
  addWaterEdgeSeeds(initialCollapses, center, radius) {
    return this.model.addWaterEdgeSeeds(initialCollapses, center, radius)
  }

  getMapCornerOceanSeeds() {
    return this.model.getMapCornerOceanSeeds()
  }


  /** Apply WFC results: update global cells, render tiles, animate, handle dropped/replaced cells */
  async _applyPopulateResults(grid, ctx, solveResult, options) {
    const { result, resultCollapseOrder, changedFixedCells, unfixedKeys, droppedFixedCubes, stats } = solveResult

    if (!result) {
      log(`[${ctx.gridKey}] WFC FAILED`, 'color: red')
      await setStatusAsync(`[${ctx.gridKey}] WFC FAILED`)
      Sounds.play('incorrect')
      return
    }

    // Log final status
    const { postDroppedCount, localWfcAttempts } = stats
    const statParts = []
    if (ctx.attempt > 1) statParts.push(`${ctx.attempt} tries`)
    if (localWfcAttempts > 0) statParts.push(`${localWfcAttempts} local-wfc`)
    if (postDroppedCount > 0) statParts.push(`${postDroppedCount} dropped`)
    const statusMsg = `[${ctx.gridKey}] WFC SUCCESS (${statParts.join(', ')})`
    if (postDroppedCount > 0) {
      const prefix = statParts.filter(s => !s.includes('dropped')).join(', ')
      const dropParts = [`${postDroppedCount} dropped`]
      // Multi-style for console (red dropped counts), status bar gets green
      console.log(`%c[${ctx.gridKey}] WFC SUCCESS (${prefix}, %c${dropParts.join(', ')}%c)`, 'color: green', 'color: red', 'color: green')
      setStatus(statusMsg)
    } else {
      log(statusMsg, 'color: green')
    }
    await setStatusAsync(statusMsg)

    // Process changed fixed cells BEFORE addToGlobalCells (which would overwrite gridKey)
    if (changedFixedCells.length > 0) {
      for (const changed of changedFixedCells) {
        const key = cubeKey(changed.q, changed.r, changed.s)
        const existing = this.globalCells.get(key)
        if (existing) {
          // Update rendered tile in source grid (before globalCells is overwritten)
          const sourceGrid = this.grids.get(existing.gridKey)
          if (sourceGrid) {
            const { gridX, gridZ } = globalToLocalGrid(changed, sourceGrid.globalCenterCube, sourceGrid.gridRadius)
            sourceGrid.replaceTile(gridX, gridZ, changed.type, changed.rotation, changed.level)
            // Remove old decorations and add bridge if new tile is a crossing
            sourceGrid.decorations?.clearDecorationsAt(gridX, gridZ)
            const replacedTile = sourceGrid.hexGrid[gridX]?.[gridZ]
            if (replacedTile) {
              sourceGrid.decorations?.addBridgeAt(replacedTile, sourceGrid.gridRadius)
            }
          }

          // Update globalCells with new tile data (keep original gridKey)
          existing.type = changed.type
          existing.rotation = changed.rotation
          existing.level = changed.level

          // Mark as replaced for orange debug labels
          const co = cubeToOffset(changed.q, changed.r, changed.s)
          this.replacedCells.add(`${co.col},${co.row}`)
        }
      }
    }

    // Process persisted-unfixed cells — compare solved result with originals, update source grids
    if (ctx.persistedUnfixedOriginals.size > 0) {
      let persistedReplacedCount = 0
      for (const [key, original] of ctx.persistedUnfixedOriginals) {
        const solvedTile = result.find(t => cubeKey(t.q, t.r, t.s) === key)
        if (!solvedTile) continue

        // Check if tile changed
        if (solvedTile.type !== original.type || solvedTile.rotation !== original.rotation || solvedTile.level !== original.level) {
          persistedReplacedCount++
          const existing = this.globalCells.get(key)
          if (existing) {
            const sourceGrid = this.grids.get(existing.gridKey)
            if (sourceGrid) {
              const { gridX, gridZ } = globalToLocalGrid(original, sourceGrid.globalCenterCube, sourceGrid.gridRadius)
              sourceGrid.replaceTile(gridX, gridZ, solvedTile.type, solvedTile.rotation, solvedTile.level)
              sourceGrid.decorations?.clearDecorationsAt(gridX, gridZ)
              const replacedTile = sourceGrid.hexGrid[gridX]?.[gridZ]
              if (replacedTile) {
                sourceGrid.decorations?.addBridgeAt(replacedTile, sourceGrid.gridRadius)
              }
            }

            existing.type = solvedTile.type
            existing.rotation = solvedTile.rotation
            existing.level = solvedTile.level

            const co = cubeToOffset(original.q, original.r, original.s)
            this.replacedCells.add(`${co.col},${co.row}`)
          }
        }
      }
    }

    // Place mountains on dropped cells to hide edge mismatches
    if (droppedFixedCubes.length > 0) {
      for (const dropped of droppedFixedCubes) {
        const key = cubeKey(dropped.q, dropped.r, dropped.s)
        const existing = this.globalCells.get(key)
        if (existing) {
          const sourceGrid = this.grids.get(existing.gridKey)
          if (sourceGrid) {
            const { gridX, gridZ } = globalToLocalGrid(dropped, sourceGrid.globalCenterCube, sourceGrid.gridRadius)
            const tile = sourceGrid.hexGrid[gridX]?.[gridZ]
            if (tile) {
              sourceGrid.decorations?.clearDecorationsAt(gridX, gridZ)
              sourceGrid.decorations?.addMountainAt(tile, sourceGrid.gridRadius)
            }
          }
        }
      }
    }

    // Add results to global cell map (exclude unfixed cells — they stay in their source grid)
    const unfixedSet = new Set([...unfixedKeys, ...ctx.persistedUnfixedKeys])
    const resultForGlobal = unfixedSet.size > 0
      ? result.filter(t => !unfixedSet.has(cubeKey(t.q, t.r, t.s)))
      : result
    this.addToGlobalCells(ctx.gridKey, resultForGlobal)

    // Populate grid from cube results (exclude unfixed cells — they're rendered in their source grid)
    const params = App.instance?.params ?? this.params
    const animate = options.animate ?? (params?.roads?.animateWFC ?? false)
    const animateDelay = options.animateDelay ?? (params?.roads?.animateDelay ?? 20)

    const resultForGrid = unfixedSet.size > 0
      ? result.filter(t => !unfixedSet.has(cubeKey(t.q, t.r, t.s)))
      : result
    const collapseOrderForGrid = unfixedSet.size > 0
      ? resultCollapseOrder.filter(t => !unfixedSet.has(cubeKey(t.q, t.r, t.s)))
      : resultCollapseOrder

    const animDuration = await grid.populateFromCubeResults(resultForGrid, collapseOrderForGrid, ctx.center, {
      animate,
      animateDelay,
    })

    // Apply current helper visibility state
    grid.setHelperVisible(this.helpersVisible)

    // Apply current outline visibility (populated grids respect the toggle)
    if (grid.outline && this.debug._outlinesVisible !== undefined) {
      grid.outline.visible = this.debug._outlinesVisible
    }

    // Notify listeners that tiles changed (for coast mask rebuild)
    // Pass animationDone promise so caller can wait for drop animation to finish
    this.onTilesChanged?.(grid.animationDone)

    return animDuration
  }

  /**
   * Check if a grid position is within the valid bounds (2 rings = 19 grids)
   * @param {number} gridX - Grid X coordinate
   * @param {number} gridZ - Grid Z coordinate
   * @returns {boolean} True if position is valid
   */
  isValidGridPosition(gridX, gridZ) {
    // Convert flat-top hex odd-q offset to cube coordinates
    const q = gridX
    const r = gridZ - Math.floor((gridX - (gridX & 1)) / 2)
    const s = -q - r
    // Hex distance = max of absolute cube coords
    const ring = Math.max(Math.abs(q), Math.abs(r), Math.abs(s))
    return ring <= 2
  }

  /**
   * Count how many populated neighbors a grid position has
   * @param {string} gridKey - Grid key to check
   * @returns {number} Number of populated neighbors
   */
  countPopulatedNeighbors(gridKey) {
    return this.getPopulatedNeighborDirections(gridKey).length
  }

  /**
   * Get directions (0-5) that have populated neighbors for a grid position
   * @param {string} gridKey - Grid key to check
   * @returns {number[]} Array of directions with populated neighbors
   */
  getPopulatedNeighborDirections(gridKey) {
    const directions = []
    for (let dir = 0; dir < 6; dir++) {
      const adjacentKey = getAdjacentGridKey(gridKey, dir)
      const adjacentGrid = this.grids.get(adjacentKey)
      if (adjacentGrid?.state === HexGridState.POPULATED) {
        directions.push(dir)
      }
    }
    return directions
  }

  /**
   * Count how many grids are populated
   * @returns {number} Number of populated grids
   */
  countPopulatedGrids() {
    let count = 0
    for (const grid of this.grids.values()) {
      if (grid.state === HexGridState.POPULATED) count++
    }
    return count
  }

  /**
   * Update triangle indicators on all placeholder grids
   * Call this after a grid is populated to update adjacent placeholders
   */
  updateAllPlaceholderTriangles() {
    for (const [key, grid] of this.grids) {
      if (grid.state === HexGridState.PLACEHOLDER) {
        const neighborDirs = this.getPopulatedNeighborDirections(key)
        grid.setPlaceholderNeighbors(neighborDirs)
      }
    }
  }

  /**
   * Remove placeholder grids that are outside bounds or don't have a populated neighbor
   */
  pruneInvalidPlaceholders() {
    for (const [key, grid] of this.grids) {
      if (grid.state !== HexGridState.PLACEHOLDER) continue

      const { x, z } = parseGridKey(key)
      const valid = this.isValidGridPosition(x, z) && this.countPopulatedNeighbors(key) >= 1

      if (!valid) {
        grid.placeholder?.hide()
        if (grid.outline) grid.outline.visible = false
      }
    }
  }

  /**
   * Create placeholder grids around a populated grid
   * Only creates within valid bounds (2 rings = 19 grids max)
   * Only creates placeholders with 1+ populated neighbors
   * @param {string} centerKey - Grid key of the populated grid
   */
  async createAdjacentPlaceholders(centerKey, fadeDelay = 0) {
    const createPromises = []
    const existingToShow = []

    for (let dir = 0; dir < 6; dir++) {
      const adjacentKey = getAdjacentGridKey(centerKey, dir)

      const { x: gridX, z: gridZ } = parseGridKey(adjacentKey)

      // Must be within bounds
      if (!this.isValidGridPosition(gridX, gridZ)) continue

      // Require at least 1 populated neighbor
      const neighborCount = this.countPopulatedNeighbors(adjacentKey)
      if (neighborCount < 1) continue

      const existing = this.grids.get(adjacentKey)
      if (existing) {
        // Already exists (pre-created) — show if it's a hidden placeholder
        if (existing.state === HexGridState.PLACEHOLDER && !existing.placeholder?.group.visible) {
          existingToShow.push(existing)
        }
        continue
      }

      createPromises.push(this.createGrid(gridX, gridZ))
    }

    const newGrids = await Promise.all(createPromises)

    // Fade in new and existing-but-hidden placeholders after WFC animation
    const allToShow = [...newGrids, ...existingToShow]
    if (fadeDelay > 0) {
      for (const grid of allToShow) {
        grid?.fadeIn(fadeDelay)
      }
    } else {
      for (const grid of existingToShow) {
        grid?.placeholder?.show()
        if (grid?.outline) grid.outline.visible = true
      }
    }
  }

  /**
   * Handle click on a grid (placeholder button clicked)
   * @param {HexGrid} grid - Grid that was clicked
   */
  async onGridClick(grid, { skipPrune = false, animate } = {}) {
    if (grid.state !== HexGridState.PLACEHOLDER) return 0

    const gridKey = getGridKey(grid.gridCoords.x, grid.gridCoords.z)
    const params = App.instance?.params

    const animDuration = await this.populateGrid(grid, [], {
      animate: animate ?? params?.roads?.animateWFC ?? false,
      animateDelay: params?.roads?.animateDelay ?? 20,
    }) || 0

    if (!skipPrune) {
      // Create placeholders around this newly populated grid, fade in after animation
      await this.createAdjacentPlaceholders(gridKey, animDuration + 300)

      // Remove placeholders outside bounds
      this.pruneInvalidPlaceholders()

      // Update triangle indicators on all remaining placeholders
      this.updateAllPlaceholderTriangles()
    }

    // Refresh tile labels if visible
    if (this.tileLabels.visible) {
      this.createTileLabels()
    }

    return animDuration
  }

  /**
   * Auto-expand grids in a given order (for testing/replay)
   * @param {Array<[number,number]>} order - Array of [gridX, gridZ] pairs
   */
  async autoBuild(order, { animate } = {}) {
    // If map is already complete, reset first
    const allPopulated = order.every(([gx, gz]) => {
      const grid = this.grids.get(getGridKey(gx, gz))
      return grid && grid.state !== HexGridState.PLACEHOLDER
    })
    if (allPopulated) await this.reset()

    log('[AUTO-BUILD] Starting', 'color: blue')
    const myEpoch = ++this._buildEpoch
    this._buildCancelled = false
    this.onBeforeTilesChanged?.()
    this._autoBuilding = true
    this._wfcQueue.length = 0  // clear any pending clicks
    await this._waitForWfcIdle()
    this._wfcBusy = true  // hold the lock for the entire build

    const startTime = performance.now()
    const animPromises = []
    const failedGrids = []
    for (let i = 0; i < order.length; i++) {
      const [gx, gz] = order[i]
      if (this._buildCancelled || this._buildEpoch !== myEpoch) {
        this._autoBuilding = false
        this._releaseWfcLock()
        log('[AUTO-BUILD] Cancelled', 'color: red')
        return { success: false, cancelled: true }
      }
      const key = getGridKey(gx, gz)
      let grid = this.grids.get(key)
      if (!grid) {
        grid = await this.createGrid(gx, gz)
      }
      if (grid.state === HexGridState.PLACEHOLDER) {
        Sounds.play('pop', 1.0, 0.2, 0.7)
        await this.onGridClick(grid, { skipPrune: true, animate })
        if (grid.state !== HexGridState.POPULATED) failedGrids.push(key)
        if (grid.animationDone) animPromises.push(grid.animationDone)
      }
    }
    this._autoBuilding = false
    this._releaseWfcLock()
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    const parts = [`${elapsed}s`]
    if (failedGrids.length > 0) parts.push(`${failedGrids.length} grid wfc failed`)
    if (this.droppedCells.size > 0) parts.push(`${this.droppedCells.size} cells dropped`)
    const color = failedGrids.length > 0 ? 'color: red' : 'color: green'
    log(`[AUTO-BUILD] Done (${parts.join(', ')})`, color)

    // Wait for all drop animations to finish, then rebuild waves mask
    await Promise.all(animPromises)
    Sounds.play('intro')
    this.onTilesChanged?.(Promise.resolve())

    return {
      success: true,
      time: elapsed,
      dropped: this.droppedCells.size,
      failed: failedGrids.length,
      failedGrids,
    }
  }

  /**
   * Build all grids in a single WFC pass (no fixed cells, no incremental solving)
   * @param {Array<[number,number]>} expansionCoords - Grid coords to populate (besides 0,0)
   * @param {Object} options - { animate, animateDelay }
   */
  async populateAllGrids(expansionCoords = null, options = {}) {
    ++this._buildEpoch
    this._buildCancelled = false
    this._autoBuilding = true
    this._wfcQueue.length = 0
    await this._waitForWfcIdle()
    this._wfcBusy = true
    if (!expansionCoords) {
      expansionCoords = getAllGridCoordinates().filter(([q, gz]) => q !== 0 || gz !== 0)
    }
    const params = App.instance?.params ?? this.params
    const animate = options.animate ?? (params?.roads?.animateWFC ?? false)
    const animateDelay = options.animateDelay ?? (params?.roads?.animateDelay ?? 20)

    // ---- Clear state (world state now owned by the model) ----
    this.isRegenerating = true
    this.model.resetWorldState()
    this.clearTileLabels()

    const gridsToDispose = [...this.grids.values()]
    this.grids.clear()
    for (const grid of gridsToDispose) {
      this.scene.remove(grid.group)
    }
    setTimeout(() => {
      for (const grid of gridsToDispose) {
        grid.dispose()
      }
    }, 500)

    this.initWfcRules()

    // ---- Create all grids (PLACEHOLDER state) ----
    const allGridCoords = [[0, 0], ...expansionCoords]
    log(`[BUILD ALL] Creating ${allGridCoords.length} grids...`, 'color: blue')

    for (const [gx, gz] of allGridCoords) {
      await this.createGrid(gx, gz)
    }

    // Allow overlay/AO bypass now that grids exist
    this.isRegenerating = false

    // Start all placeholders spinning
    for (const grid of this.grids.values()) {
      grid.placeholder?.startSpinning()
    }

    // ---- Solve entire map in a single WFC pass (delegated to the world model) ----
    const gridSpecs = allGridCoords
      .map(([gx, gz]) => {
        const grid = this.grids.get(getGridKey(gx, gz))
        return grid ? { key: getGridKey(gx, gz), centerCube: grid.globalCenterCube, radius: this.hexGridRadius } : null
      })
      .filter(Boolean)

    log(`[BUILD ALL] Solving across ${allGridCoords.length} grids`, 'color: blue')
    await setStatusAsync(`[BUILD ALL] Solving ${gridSpecs.length} grids...`)
    const startTime = performance.now()

    const solveResult = await this.model.solveAllGrids(gridSpecs)

    if (this._buildCancelled) {
      this._autoBuilding = false
      this._releaseWfcLock()
      log('[BUILD ALL] Cancelled', 'color: red')
      return { success: false, cancelled: true }
    }

    if (!solveResult.success) {
      this._autoBuilding = false
      this._releaseWfcLock()
      log('[BUILD ALL] WFC FAILED', 'color: red')
      const { Sounds } = await import('../lib/Sounds.js')
      Sounds.play('incorrect')
      await setStatusAsync('[BUILD ALL] WFC FAILED')
      for (const grid of this.grids.values()) {
        grid.placeholder?.stopSpinning()
      }
      return { success: false }
    }

    const solveTime = ((performance.now() - startTime) / 1000).toFixed(1)
    log(`[BUILD ALL] WFC SUCCESS (${solveResult.tiles.length} tiles, ${solveTime}s, ${solveResult.backtracks || 0} backtracks, ${solveResult.tries || 0} tries)`, 'color: green')
    await setStatusAsync(`[BUILD ALL] Success! Distributing ${solveResult.tiles.length} tiles...`)

    // ---- Distribute partitioned results to each grid ----
    for (const [gx, gz] of allGridCoords) {
      const gridKey = getGridKey(gx, gz)
      const grid = this.grids.get(gridKey)
      if (!grid) continue

      const { tiles: gridTiles, collapseOrder: gridCollapseOrder } =
        solveResult.perGrid.get(gridKey) || { tiles: [], collapseOrder: [] }

      // Add to global cells
      this.addToGlobalCells(gridKey, gridTiles)

      // Populate the grid visuals
      await grid.populateFromCubeResults(gridTiles, gridCollapseOrder, grid.globalCenterCube, {
        animate,
        animateDelay,
      })

      grid.setHelperVisible(this.helpersVisible)
      if (grid.outline && this.debug._outlinesVisible !== undefined) {
        grid.outline.visible = this.debug._outlinesVisible
      }
    }

    // ---- Create placeholders for further expansion ----
    for (const [gx, gz] of allGridCoords) {
      const gridKey = getGridKey(gx, gz)
      await this.createAdjacentPlaceholders(gridKey)
    }
    this.pruneInvalidPlaceholders()
    this.updateAllPlaceholderTriangles()

    // ---- Cleanup ----
    if (this.tileLabels.visible) {
      this.createTileLabels()
    }

    this._autoBuilding = false
    this._releaseWfcLock()
    const totalTime = ((performance.now() - startTime) / 1000).toFixed(1)
    log(`[BUILD ALL] Complete (${totalTime}s total)`, 'color: green')
    await setStatusAsync(`[BUILD ALL] Complete (${totalTime}s)`)
    Sounds.play('good')

    // Notify listeners that tiles changed (for coast mask rebuild + wave fade-in)
    // Collect all grid animation promises
    const animPromises = []
    for (const grid of this.grids.values()) {
      if (grid.animationDone) animPromises.push(grid.animationDone)
    }
    this.onTilesChanged?.(Promise.all(animPromises))

    return { success: true, time: parseFloat(totalTime), backtracks: solveResult.backtracks || 0, tries: solveResult.tries || 0 }
  }

  /**
   * Calculate world offset for grid coordinates
   * Traverses from origin using getGridWorldOffset for consistency
   */
  // Pure geometry is delegated to the world model (kept free of Three.js).
  calculateWorldOffset(gridX, gridZ) {
    return this.model.calculateWorldOffset(gridX, gridZ)
  }

  // ---- WFC solve queue (serializes all WFC operations) ----

  /**
   * Enqueue an async WFC operation. Only one runs at a time.
   * Rejects silently during build seq (_autoBuilding).
   */
  _enqueueWfc(fn) {
    if (this._autoBuilding) return
    if (this._wfcBusy) {
      this._wfcQueue.push(fn)
      return
    }
    this._drainWfcQueue(fn)
  }

  async _drainWfcQueue(fn) {
    this._wfcBusy = true
    try { await fn() } catch (e) { console.error('[WFC Queue]', e) }
    while (this._wfcQueue.length > 0) {
      if (this._autoBuilding) { this._wfcQueue.length = 0; break }
      const next = this._wfcQueue.shift()
      try { await next() } catch (e) { console.error('[WFC Queue]', e) }
    }
    this._releaseWfcLock()
  }

  /** Returns a promise that resolves when the queue is idle */
  _waitForWfcIdle() {
    if (!this._wfcBusy) return Promise.resolve()
    return new Promise(resolve => { this._wfcIdleResolve = resolve })
  }

  /** Release the WFC lock and notify anyone waiting */
  _releaseWfcLock() {
    this._wfcBusy = false
    if (this._wfcIdleResolve) {
      this._wfcIdleResolve()
      this._wfcIdleResolve = null
    }
  }

  // ---- Rebuild-WFC (mini WFC on tile click in rebuild mode) ----

  queueRebuildWfc(globalCubeCoords, global, def) {
    if (this._autoBuilding) return
    this._enqueueWfc(() => this._runRebuildWfc({ globalCubeCoords, global, def }))
  }

  async _runRebuildWfc({ globalCubeCoords, global, def }) {
    log(`[REBUILD] (${global.col},${global.row}) ${def?.name || '?'} — rebuild WFC solve`, 'color: blue')

    const solveCells = cubeCoordsInRadius(
      globalCubeCoords.q, globalCubeCoords.r, globalCubeCoords.s, 2
    ).filter(c => this.globalCells.has(cubeKey(c.q, c.r, c.s)))

    const fixedCells = this.getFixedCellsForRegion(solveCells)
    const tileTypes = this.getDefaultTileTypes()

    const result = await this.solveWfcAsync(solveCells, fixedCells, {
      tileTypes,
      maxTries: 5,
    })

    if (result.success && result.tiles) {
      const changedTilesPerGrid = this.applyTileResultsToGrids(result.tiles)

      // Sort changed tiles by WFC collapse order
      const collapseIndex = new Map()
      if (result.collapseOrder) {
        result.collapseOrder.forEach((c, i) => collapseIndex.set(cubeKey(c.q, c.r, c.s), i))
      }
      for (const [g, tiles] of changedTilesPerGrid) {
        const center = g.globalCenterCube
        tiles.sort((a, b) => {
          const ca = offsetToCube(a.gridX - g.gridRadius, a.gridZ - g.gridRadius)
          const cb = offsetToCube(b.gridX - g.gridRadius, b.gridZ - g.gridRadius)
          const ia = collapseIndex.get(cubeKey(ca.q + center.q, ca.r + center.r, ca.s + center.s)) ?? Infinity
          const ib = collapseIndex.get(cubeKey(cb.q + center.q, cb.r + center.r, cb.s + center.s)) ?? Infinity
          return ia - ib
        })
      }

      // Hide changed tiles before animating (prevent flash at final position)
      const TILE_STAGGER = 60
      const DEC_DELAY = 400
      const DEC_STAGGER = 40
      for (const [g, tiles] of changedTilesPerGrid) {
        g.dummy.scale.setScalar(0)
        g.dummy.updateMatrix()
        for (const t of tiles) {
          if (t.instanceId !== null) g.hexMesh.setMatrixAt(t.instanceId, g.dummy.matrix)
          const fillId = g.bottomFills.get(`${t.gridX},${t.gridZ}`)
          if (fillId !== undefined) g.hexMesh.setMatrixAt(fillId, g.dummy.matrix)
        }

        tiles.forEach((t, i) => {
          setTimeout(() => g.animateTileDrop(t, { fadeIn: true }), i * TILE_STAGGER)
        })
        const newDecs = g.decorations?.repopulateTilesAt(tiles, g.gridRadius, g.hexGrid)
        if (newDecs && newDecs.length > 0) {
          // Hide new decorations before animating
          for (const dec of newDecs) {
            try { dec.mesh.setMatrixAt(dec.instanceId, g.dummy.matrix) } catch (_) {}
          }
          const decStart = tiles.length * TILE_STAGGER + DEC_DELAY
          newDecs.forEach((dec, j) => {
            setTimeout(() => g.animateDecoration(dec), decStart + j * DEC_STAGGER)
          })
        }
      }

      this.addToGlobalCells('rebuild-wfc', result.tiles)
      // Estimate total animation time: last tile drop start + drop duration (400ms)
      const totalTiles = Array.from(changedTilesPerGrid.values()).reduce((sum, t) => sum + t.length, 0)
      const animDone = new Promise(resolve => setTimeout(resolve, totalTiles * TILE_STAGGER + 400))
      this.onTilesChanged?.(animDone)

      log(`[REBUILD] (${global.col},${global.row}) solved ${result.tiles.length} tiles`, 'color: green')
      Sounds.play('pop', 1.0, 0.15)
    } else {
      log(`[REBUILD] (${global.col},${global.row}) ${def?.name || '?'} — rebuild WFC failed`, 'color: red')
      Sounds.play('incorrect')
    }
  }

  // ---- HexMapInteraction delegators ----
  onPointerMove(pointer, camera) { this.interaction.onPointerMove(pointer, camera) }
  onPointerDown(pointer, camera) { return this.interaction.onPointerDown(pointer, camera) }
  clearHoverHighlight() { this.interaction.clearHoverHighlight() }

  async runBenchmark(runs = 3) {
    const autoBuildOrder = [
      [0,0],[0,-1],[1,-1],[1,0],[0,1],[-1,0],[-1,-1],[-1,-2],[0,-2],[1,-2],[2,-1],[2,0],[2,1],[1,1],[0,2],[-1,1],[-2,1],[-2,0],[-2,-1]
    ]
    log(`[BENCHMARK] Starting ${runs} Auto-Build runs`, 'color: blue')
    const results = []

    for (let i = 0; i < runs; i++) {
      const seed = Math.floor(Math.random() * 100000)
      log(`[BENCHMARK] Run ${i + 1}/${runs} (seed: ${seed})`, 'color: blue')

      setSeed(seed)
      rebuildNoiseTables()
      await this.reset()

      const result = await this.autoBuild(autoBuildOrder, { animate: false })
      results.push({ seed, ...(result || { success: false }) })

      if (result?.success) {
        await new Promise(r => setTimeout(r, 1000))
        App.instance?.exportPNG({ filename: `benchmark-${i + 1}-seed${seed}.jpg` })
      }

      if (this._buildCancelled) {
        log('[BENCHMARK] Cancelled', 'color: red')
        break
      }
    }

    const successes = results.filter(r => r.success).length
    const failures = results.filter(r => !r.success && !r.cancelled).length
    const totalFailedGrids = results.reduce((sum, r) => sum + (r.failed || 0), 0)
    const times = results.filter(r => r.success).map(r => parseFloat(r.time))
    const avgTime = times.length ? (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1) : '-'

    log(`[BENCHMARK] === RESULTS ===`, 'color: green')
    const summaryParts = [`${successes}/${results.length} succeeded`, `${failures} failed`, `avg time: ${avgTime}s`]
    if (totalFailedGrids > 0) summaryParts.push(`${totalFailedGrids} grid wfc failed`)
    log(`[BENCHMARK] ${summaryParts.join(', ')}`, 'color: green')

    Sounds.play('intro')
  }

  async runBuildAllBenchmark(runs = 3) {
    log(`[BENCHMARK-BA] Starting ${runs} Build-All runs`, 'color: blue')
    const results = []

    for (let i = 0; i < runs; i++) {
      const seed = Math.floor(Math.random() * 100000)
      log(`[BENCHMARK-BA] Run ${i + 1}/${runs} (seed: ${seed})`, 'color: blue')

      setSeed(seed)
      rebuildNoiseTables()
      await this.reset()

      const result = await this.populateAllGrids(null, { animate: false })
      results.push({ seed, ...(result || { success: false }) })

      if (this._buildCancelled) {
        log('[BENCHMARK-BA] Cancelled', 'color: red')
        break
      }
    }

    const successes = results.filter(r => r.success).length
    const failures = results.filter(r => !r.success && !r.cancelled).length
    const times = results.filter(r => r.success).map(r => r.time)
    const avgTime = times.length ? (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1) : '-'
    const backtracks = results.filter(r => r.success).map(r => r.backtracks || 0)
    const avgBT = backtracks.length ? (backtracks.reduce((a, b) => a + b, 0) / backtracks.length).toFixed(0) : '-'

    log(`[BENCHMARK-BA] === RESULTS ===`, 'color: green')
    log(`[BENCHMARK-BA] ${successes}/${results.length} succeeded, ${failures} failed, avg time: ${avgTime}s, avg backtracks: ${avgBT}`, 'color: green')
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.success) {
        log(`[BENCHMARK-BA]   Run ${i + 1} (seed ${r.seed}): SUCCESS (${r.time}s, ${r.backtracks || 0} backtracks, ${r.tries || 0} tries)`, 'color: green')
      } else if (!r.cancelled) {
        log(`[BENCHMARK-BA]   Run ${i + 1} (seed ${r.seed}): FAIL`, 'color: red')
      }
    }

    Sounds.play('intro')
  }


  async reset() {
    ++this._buildEpoch
    this._buildCancelled = true
    this._autoBuilding = false
    this._wfcQueue.length = 0
    await this._waitForWfcIdle()
    this.isRegenerating = true

    this.model.resetWorldState()
    this.clearTileLabels()

    const gridsToDispose = [...this.grids.values()]
    this.grids.clear()

    for (const grid of gridsToDispose) {
      this.scene.remove(grid.group)
    }
    setTimeout(() => {
      for (const grid of gridsToDispose) grid.dispose()
    }, 500)

    this.initWfcRules()
    this.wfcManager.cancelAndRestart()

    // Create center placeholder only — no WFC solve
    await this.createGrid(0, 0)

    this.isRegenerating = false

    // Clear waves mask (no tiles to render)
    this.onTilesChanged?.(Promise.resolve())
  }

  async regenerate(options = {}) {
    await this.regenerateAll(options)
  }

  async regenerateAll(options = {}) {
    this._autoBuilding = false
    this._wfcQueue.length = 0
    await this._waitForWfcIdle()
    this._wfcBusy = true

    // Set flag to prevent overlay rendering during disposal
    this.isRegenerating = true

    // Clear global state (world state now owned by the model)
    this.model.resetWorldState()

    // Clear labels first (they reference grid data)
    this.clearTileLabels()

    // Collect grids to dispose, then clear map FIRST
    // (so getOverlayObjects() won't return disposed objects)
    const gridsToDispose = [...this.grids.values()]
    this.grids.clear()

    // Remove all grid groups from scene BEFORE waiting
    // (so they won't be rendered during the wait)
    for (const grid of gridsToDispose) {
      this.scene.remove(grid.group)
    }

    // Defer disposal to ensure GPU queue has finished with textures
    setTimeout(() => {
      for (const grid of gridsToDispose) {
        grid.dispose()
      }
    }, 500)

    // Clear WFC rules to pick up any changes
    this.initWfcRules()

    // Create center grid and populate it
    const centerGrid = await this.createGrid(0, 0)
    await this.populateGrid(centerGrid, [], options)

    // Create placeholders around center
    await this.createAdjacentPlaceholders('0,0')

    // Refresh labels if visible
    if (this.tileLabels.visible) {
      this.createTileLabels()
    }

    // Clear regeneration flag
    this.isRegenerating = false
    this._releaseWfcLock()
  }

  update(dt) {
  }

  // === Water uniform proxies (GUI accesses via app.city._waterSpeed etc.) ===
  get waterPlane() { return this.water?.mesh }
  get _waterOpacity() { return this.water?._waterOpacity }
  get _waterSpeed() { return this.water?._waterSpeed }
  get _waterFreq() { return this.water?._waterFreq }
  get _waterAngle() { return this.water?._waterAngle }
  get _waterBrightness() { return this.water?._waterBrightness }
  get _waterContrast() { return this.water?._waterContrast }
  get _waveSpeed() { return this.water?._waveSpeed }
  get _waveCount() { return this.water?._waveCount }
  get _waveOpacity() { return this.water?._waveOpacity }
  get _waveNoiseBreak() { return this.water?._waveNoiseBreak }
  get _waveWidth() { return this.water?._waveWidth }
  get _waveOffset() { return this.water?._waveOffset }
  get _waveGradientOpacity() { return this.water?._waveGradientOpacity }
  get _waveGradientColor() { return this.water?._waveGradientColor }
  get _waveMaskStrength() { return this.water?._waveMaskStrength }
  get _coveStrength() { return this.water?._coveStrength }
  get _coveFade() { return this.water?._coveFade }
  get _coveThin() { return this.water?._coveThin }
  get _coveShow() { return this.water?._coveShow }

  // === Accessors for backward compatibility ===

  /**
   * Get all hex tiles across all grids
   */
  get hexTiles() {
    const allTiles = []
    for (const grid of this.grids.values()) {
      allTiles.push(...grid.hexTiles)
    }
    return allTiles
  }

  /**
   * Get hex grid (returns center grid for compatibility)
   */
  get hexGrid() {
    return this.grids.get('0,0')?.hexGrid ?? null
  }

  /**
   * Get WFC grid radius
   */
  get wfcGridRadius() {
    return this.hexGridRadius
  }

  // ---- HexMapDebug delegators ----
  clearTileLabels() { this.debug.clearTileLabels() }
  createTileLabels() { this.debug.createTileLabels() }
  setTileLabelsVisible(visible) { this.debug.setTileLabelsVisible(visible) }
  setHelpersVisible(visible) { this.debug.setHelpersVisible(visible) }
  setAxesHelpersVisible(visible) { this.debug.setAxesHelpersVisible(visible) }
  setOutlinesVisible(visible) { this.debug.setOutlinesVisible(visible) }
  repopulateDecorations() { this.debug.repopulateDecorations() }
  setWhiteMode(enabled) { this.debug.setWhiteMode(enabled) }
  _updateColorNode() { this.debug._updateColorNode() }
  updateTileColors() { this.debug.updateTileColors() }
  getOverlayObjects() { return this.debug.getOverlayObjects() }
  getWaterObjects() {
    const water = []
    if (this.water?.mesh) water.push(this.water.mesh)
    return water
  }

  /**
   * Swap a biome texture at runtime (lo or hi) — stays on HexMap (tightly coupled to material init)
   */
  swapBiomeTexture(slot, path) {
    const node = slot === 'lo' ? this._texNodeA : this._texNodeB
    if (!node) return
    const ref = this._texA
    const loader = new TextureLoader()
    loader.load(path, (tex) => {
      if (ref) {
        tex.flipY = ref.flipY
        tex.colorSpace = ref.colorSpace
        tex.wrapS = ref.wrapS
        tex.wrapT = ref.wrapT
        tex.channel = ref.channel
      }
      tex.needsUpdate = true
      node.value = tex
      if (slot === 'lo') this._texA = tex
      else this._texB = tex
      this.roadMaterial.needsUpdate = true
    })
  }

  // Stub methods for App.js compatibility
  onHover() {}
  onPointerUp() {}
  onRightClick() {}
  startIntroAnimation() {}
}
