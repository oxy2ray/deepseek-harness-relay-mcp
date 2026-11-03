import assert from 'node:assert/strict'
import test from 'node:test'
import { projectAgentPresetCatalog } from '../src/agent-presets/index.js'

test('projects current native preset names, descriptions, ordering, and status without changing metadata', () => {
  const raw = {
    presets: [
      { id: 'standard', isDefault: true, order: 1, broken: undefined, extra: 'ignored' },
      { id: 'redteam', isDefault: false, name: 'Red team', description: 'Review adversarially.', order: 8, broken: 'plugin load failed' },
      { id: 'renamed-empty-copy', isDefault: false, name: '', description: '', order: 9 },
    ],
  }

  assert.deepEqual(projectAgentPresetCatalog(raw), {
    presets: [
      { id: 'standard', isDefault: true, order: 1 },
      { id: 'redteam', isDefault: false, name: 'Red team', description: 'Review adversarially.', order: 8, broken: 'plugin load failed' },
      { id: 'renamed-empty-copy', isDefault: false, name: '', description: '', order: 9 },
    ],
    metadataSource: 'harness-live',
    missingDisplayMetadata: [
      { id: 'standard', fields: ['name', 'description'] },
    ],
  })
})

test('each projection reflects a fresh native roster and does not leak source mutations', () => {
  const first = projectAgentPresetCatalog({ presets: [{ id: 'old', isDefault: true, name: 'Old' }] })
  const second = projectAgentPresetCatalog({ presets: [{ id: 'new', isDefault: false, name: 'New' }] })

  assert.deepEqual(first.presets.map(({ id }) => id), ['old'])
  assert.deepEqual(second.presets.map(({ id }) => id), ['new'])
  assert.deepEqual(second.missingDisplayMetadata, [{ id: 'new', fields: ['description'] }])

  first.presets[0]!.name = 'mutated projection'
  first.missingDisplayMetadata[0]!.fields.push('name')
  assert.equal(second.presets[0]?.name, 'New')
  assert.deepEqual(second.missingDisplayMetadata, [{ id: 'new', fields: ['description'] }])
})

test('missing display metadata is explicit and optional native fields stay omitted', () => {
  const result = projectAgentPresetCatalog({ presets: [{ id: 'minimal', isDefault: false, broken: '' }] })

  assert.deepEqual(result, {
    presets: [{ id: 'minimal', isDefault: false, broken: '' }],
    metadataSource: 'harness-live',
    missingDisplayMetadata: [{ id: 'minimal', fields: ['name', 'description'] }],
  })
  assert.equal(Object.hasOwn(result.presets[0]!, 'name'), false)
  assert.equal(Object.hasOwn(result.presets[0]!, 'description'), false)
})

test('fails closed on invalid roots, row shapes, required fields, and duplicate ids', () => {
  const invalid: unknown[] = [
    null,
    [],
    {},
    { presets: {} },
    { presets: [null] },
    { presets: [{ id: '', isDefault: false }] },
    { presets: [{ id: 'x' }] },
    { presets: [{ id: 'x', isDefault: 'true' }] },
    { presets: [{ id: 'x', isDefault: false, name: 4 }] },
    { presets: [{ id: 'x', isDefault: false, description: null }] },
    { presets: [{ id: 'x', isDefault: false, order: '1' }] },
    { presets: [{ id: 'x', isDefault: false, order: Number.NaN }] },
    { presets: [{ id: 'x', isDefault: false, broken: false }] },
    { presets: [{ id: 'x', isDefault: false }, { id: 'x', isDefault: true }] },
  ]

  for (const value of invalid) {
    assert.throws(() => projectAgentPresetCatalog(value as Record<string, unknown>), TypeError)
  }
})
