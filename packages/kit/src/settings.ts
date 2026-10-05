// Settings the units declare as DSH Config fields (docs/settings/research.md). Fields marked
// `.volatile()` are edited on the settings page and apply without restarting the unit; DSH saves
// them in the profile's own cordis.patch.yml.
import Schema from '@deepseek-ai/schemastery'

/** Schema role of a field holding one role's model; the settings page lists these as 模型分工, labelled by their description. */
export const MODEL_ROLE = 'learning-model'

/**
 * Config field for the model one role uses (PLAN §9.5), written `provider/model` (the model id may hold
 * more slashes, provider ids never do). Absent follows the default model. A string rather than an object:
 * an absent object field resolves to `{}`, which fails its required members when DSH loads the unit.
 */
export function roleModel(label: string) {
  return Schema.string().role(MODEL_ROLE).description(label).volatile()
}

export { Schema }
