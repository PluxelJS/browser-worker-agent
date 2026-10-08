// assistant-ui registry: https://r.assistant-ui.com/model-selector.json
// Retrieved source SHA-256: fa58d6cb2392e7d57d58d7d560008953f95025b1bd0a58b7539a61f7283557c1; compatible with @assistant-ui/react 0.15.23.

import { memo, useEffect } from 'react'
import { useAui } from '@assistant-ui/react'
import {
	ModelSelectorRoot,
	ModelSelectorTrigger,
	ModelSelectorValue,
	ModelSelectorContent,
	ModelSelectorSearch,
	ModelSelectorFocusAnchor,
	ModelSelectorList,
	ModelSelectorEmpty,
	ModelSelectorGroup,
	ModelSelectorSeparator,
	ModelSelectorItem,
	ModelSelectorEffort,
	useModelSelectorContext,
	type ModelSelectorProps,
} from './model-selector.tsx'

export {
	DEFAULT_EFFORT_OPTIONS,
	modelSelectorTriggerVariants,
	resolveModelEffort,
	useModelSelectorEfforts,
	ModelSelectorRoot,
	ModelSelectorTrigger,
	ModelSelectorValue,
	ModelSelectorContent,
	ModelSelectorSearch,
	ModelSelectorFocusAnchor,
	ModelSelectorList,
	ModelSelectorEmpty,
	ModelSelectorGroup,
	ModelSelectorSeparator,
	ModelSelectorItem,
	ModelSelectorEffort,
} from './model-selector.tsx'

export type {
	ModelOption,
	ModelSelectorEffortOption,
	ModelSelectorProps,
	ModelSelectorRootProps,
	ModelSelectorTriggerProps,
	ModelSelectorValueProps,
	ModelSelectorContentProps,
	ModelSelectorSearchProps,
	ModelSelectorListProps,
	ModelSelectorEmptyProps,
	ModelSelectorGroupProps,
	ModelSelectorSeparatorProps,
	ModelSelectorItemProps,
	ModelSelectorEffortProps,
} from './model-selector.tsx'

/** Registers the selection with assistant-ui's ModelContext system. The
 * context's effort is already resolved against the selected model. */
export function ModelSelectorModelContext() {
	const { value, effort } = useModelSelectorContext()
	const api = useAui()

	useEffect(() => {
		if (!value) return
		const config = {
			config: {
				modelName: value,
				...(effort !== undefined ? { reasoningEffort: effort } : undefined),
			},
		}
		return api.modelContext.register({
			getModelContext: () => config,
		})
	}, [api, value, effort])

	return null
}

const ModelSelectorImpl = ({
	searchable,
	variant,
	size,
	align,
	className,
	contentClassName,
	...rootProps
}: ModelSelectorProps) => {
	return (
		<ModelSelectorRoot {...rootProps}>
			<ModelSelectorModelContext />
			<ModelSelectorTrigger variant={variant} size={size} className={className} />
			<ModelSelectorContent
				{...(align !== undefined ? { align } : {})}
				className={contentClassName}
				searchable={searchable ?? false}
			/>
		</ModelSelectorRoot>
	)
}

type ModelSelectorComponent = typeof ModelSelectorImpl & {
	displayName?: string
	Root: typeof ModelSelectorRoot
	Trigger: typeof ModelSelectorTrigger
	Value: typeof ModelSelectorValue
	Content: typeof ModelSelectorContent
	Search: typeof ModelSelectorSearch
	FocusAnchor: typeof ModelSelectorFocusAnchor
	List: typeof ModelSelectorList
	Empty: typeof ModelSelectorEmpty
	Group: typeof ModelSelectorGroup
	Separator: typeof ModelSelectorSeparator
	Item: typeof ModelSelectorItem
	Effort: typeof ModelSelectorEffort
}

const ModelSelector = memo(ModelSelectorImpl) as unknown as ModelSelectorComponent

ModelSelector.displayName = 'ModelSelector'
ModelSelector.Root = ModelSelectorRoot
ModelSelector.Trigger = ModelSelectorTrigger
ModelSelector.Value = ModelSelectorValue
ModelSelector.Content = ModelSelectorContent
ModelSelector.Search = ModelSelectorSearch
ModelSelector.FocusAnchor = ModelSelectorFocusAnchor
ModelSelector.List = ModelSelectorList
ModelSelector.Empty = ModelSelectorEmpty
ModelSelector.Group = ModelSelectorGroup
ModelSelector.Separator = ModelSelectorSeparator
ModelSelector.Item = ModelSelectorItem
ModelSelector.Effort = ModelSelectorEffort

export { ModelSelector }
