export interface NativeAgentPresetRow {
  id: string
  isDefault: boolean
  name?: string
  description?: string
  order?: number
  broken?: string
}

export type MissingAgentPresetDisplayField = 'name' | 'description'

export interface MissingAgentPresetDisplayMetadata {
  id: string
  fields: MissingAgentPresetDisplayField[]
}

export interface AgentPresetCatalog {
  presets: NativeAgentPresetRow[]
  metadataSource: 'harness-live'
  missingDisplayMetadata: MissingAgentPresetDisplayMetadata[]
}

/**
 * Project a fresh native Harness roster into Relay's public preset catalog.
 * Unknown additive fields are ignored; known fields are validated and copied.
 */
export function projectAgentPresetCatalog(raw: Record<string, unknown>): AgentPresetCatalog {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('Harness agent preset catalog must be an object')
  }
  const source = raw.presets
  if (!Array.isArray(source)) throw new TypeError('Harness agent preset catalog presets must be an array')

  const seen = new Set<string>()
  const presets: NativeAgentPresetRow[] = []
  const missingDisplayMetadata: MissingAgentPresetDisplayMetadata[] = []

  for (let index = 0; index < source.length; index++) {
    const candidate: unknown = source[index]
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new TypeError(`Harness agent preset at index ${index} must be an object`)
    }
    const row = candidate as Record<string, unknown>
    const id = requiredString(row, 'id', index)
    if (id.length === 0) throw new TypeError(`Harness agent preset at index ${index} has an empty id`)
    if (seen.has(id)) throw new TypeError(`Harness agent preset id is duplicated: ${id}`)
    seen.add(id)

    if (typeof row.isDefault !== 'boolean') {
      throw new TypeError(`Harness agent preset ${id} is missing boolean isDefault`)
    }

    const name = optionalString(row, 'name', id)
    const description = optionalString(row, 'description', id)
    const order = optionalNumber(row, 'order', id)
    const broken = optionalString(row, 'broken', id)
    const projected: NativeAgentPresetRow = {
      id,
      isDefault: row.isDefault,
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(order === undefined ? {} : { order }),
      ...(broken === undefined ? {} : { broken }),
    }
    presets.push(projected)

    const fields: MissingAgentPresetDisplayField[] = []
    if (name === undefined) fields.push('name')
    if (description === undefined) fields.push('description')
    if (fields.length > 0) missingDisplayMetadata.push({ id, fields })
  }

  return { presets, metadataSource: 'harness-live', missingDisplayMetadata }
}

function requiredString(row: Record<string, unknown>, key: string, index: number): string {
  if (typeof row[key] !== 'string') throw new TypeError(`Harness agent preset at index ${index} is missing string ${key}`)
  return row[key]
}

function optionalString(row: Record<string, unknown>, key: string, id: string): string | undefined {
  const value = row[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`Harness agent preset ${id} has non-string ${key}`)
  return value
}

function optionalNumber(row: Record<string, unknown>, key: string, id: string): number | undefined {
  const value = row[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Harness agent preset ${id} has non-finite numeric ${key}`)
  }
  return value
}
