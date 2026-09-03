/**
 * WFC Web Worker
 * Runs WFC solver in a separate thread to prevent UI freezing
 */

import { setSeed } from '../SeededRandom.js'
import { HexWFCAdjacencyRules } from '../hexmap/HexWFCCore.js'
import { HexWFCSolver } from '../hexmap/HexWFCSolver.js'
let currentRequestId = null

self.onmessage = function(e) {
  const { type, id } = e.data

  if (type === 'init') {
    if (e.data.seed != null) {
      setSeed(e.data.seed)
    }
    return
  }

  if (type === 'solve') {
    currentRequestId = id
    const { solveCells, fixedCells, options } = e.data

    const tileTypes = options?.tileTypes ?? null
    const rules = HexWFCAdjacencyRules.fromTileDefinitions(tileTypes)

    const solver = new HexWFCSolver(rules, {
      ...options,
      log: (message, color) => {
        if (currentRequestId === id) {
          self.postMessage({ type: 'log', id, message, color })
        }
      }
    })

    // Initialize neighbor cell data before solving
    solver.initNeighborData(options?.neighborCells)

    const result = solver.solve(
      solveCells,
      fixedCells,
      options?.initialCollapses ?? []
    )
    const collapseOrder = solver.collapseOrder || []
    const neighborConflict = solver.neighborConflict
    const lastConflict = solver.lastConflict

    self.postMessage({
      type: 'result',
      id,
      success: result !== null,
      tiles: result,
      collapseOrder,
      neighborConflict,
      lastConflict,
      changedFixedCells: solver.changedFixedCells || [],
      unfixedKeys: solver.unfixedKeys || [],
      backtracks: solver.backtracks || 0,
      tries: solver.tryCount || 0,
    })
  }
}

