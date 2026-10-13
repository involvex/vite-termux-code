/**
 * Extension Settings Component
 *
 * UI for configuring an extension's settings based on its configuration contribution.
 */

import {useCallback, useEffect, useState} from 'react'
import type {ConfigurationProperty} from '../lib/extension'
import {
	getExtension,
	getExtensionConfiguration,
	getExtensionConfigValue,
	setExtensionConfigValue,
} from '../lib/extensionHost'
import {useAppStore} from '../store/useAppStore'

interface Props {
	extensionId: string
	onClose: () => void
}

export default function ExtensionSettings({extensionId, onClose}: Props) {
	const {setStatus} = useAppStore()
	const [config, setConfig] = useState<{
		title: string
		properties: Record<string, ConfigurationProperty>
	} | null>(null)
	const [values, setValues] = useState<Record<string, any>>({})
	const [loading, setLoading] = useState(true)
	const [saving, setSaving] = useState(false)

	const loadConfig = useCallback(() => {
		const ext = getExtension(extensionId)
		if (!ext) {
			setLoading(false)
			return
		}
		const configuration = getExtensionConfiguration(extensionId)
		if (!configuration) {
			setLoading(false)
			return
		}

		setConfig(configuration)

		// Load current values for each property
		const currentValues: Record<string, any> = {}
		for (const key of Object.keys(configuration.properties)) {
			currentValues[key] = getExtensionConfigValue(extensionId, key)
		}
		setValues(currentValues)
		setLoading(false)
	}, [extensionId])

	useEffect(() => {
		loadConfig()
	}, [loadConfig])

	const handleChange = (key: string, value: any) => {
		setValues(prev => ({...prev, [key]: value}))
	}

	const handleSave = async () => {
		setSaving(true)
		try {
			for (const [key, value] of Object.entries(values)) {
				setExtensionConfigValue(extensionId, key, value, 'workspace')
			}
			setStatus('Settings saved')
		} catch (e) {
			setStatus(e instanceof Error ? e.message : 'Save failed')
		} finally {
			setSaving(false)
		}
	}

	const handleReset = (key: string) => {
		const prop = config?.properties[key]
		if (prop?.default !== undefined) {
			handleChange(key, prop.default)
		}
	}

	const renderProperty = (key: string, prop: ConfigurationProperty) => {
		const value = values[key] ?? prop.default

		return (
			<div
				className="setting-row"
				key={key}
			>
				<label
					className="setting-label"
					htmlFor={key}
				>
					<span className="setting-title">{key}</span>
					{prop.description && (
						<span className="setting-description">{prop.description}</span>
					)}
				</label>
				<div className="setting-control">
					{prop.type === 'boolean' && (
						<input
							type="checkbox"
							id={key}
							checked={Boolean(value)}
							onChange={e => handleChange(key, e.target.checked)}
						/>
					)}
					{prop.type === 'string' && !prop.enum && (
						<input
							type="text"
							id={key}
							className="tree-filter"
							value={value ?? ''}
							onChange={e => handleChange(key, e.target.value)}
							placeholder={prop.default ?? ''}
						/>
					)}
					{prop.type === 'number' && (
						<input
							type="number"
							id={key}
							className="tree-filter"
							value={value ?? ''}
							onChange={e => handleChange(key, Number(e.target.value) || 0)}
							placeholder={prop.default ?? ''}
						/>
					)}
					{prop.enum && (
						<select
							id={key}
							className="tree-filter"
							value={value ?? ''}
							onChange={e => handleChange(key, e.target.value)}
						>
							<option value="">Select...</option>
							{prop.enum.map((opt, idx) => (
								<option
									key={idx}
									value={opt}
								>
									{prop.enumDescriptions?.[idx] ?? opt}
								</option>
							))}
						</select>
					)}
					{prop.type === 'object' && (
						<textarea
							id={key}
							className="tree-filter"
							value={JSON.stringify(value, null, 2)}
							onChange={e => {
								try {
									handleChange(key, JSON.parse(e.target.value))
								} catch {
									// invalid JSON, ignore
								}
							}}
							rows={4}
							style={{fontFamily: 'var(--mono)', fontSize: '12px'}}
						/>
					)}
					{prop.type === 'array' && (
						<textarea
							id={key}
							className="tree-filter"
							value={JSON.stringify(value, null, 2)}
							onChange={e => {
								try {
									handleChange(key, JSON.parse(e.target.value))
								} catch {
									// invalid JSON, ignore
								}
							}}
							rows={4}
							style={{fontFamily: 'var(--mono)', fontSize: '12px'}}
						/>
					)}
					{(prop.default !== undefined ||
						prop.type === 'object' ||
						prop.type === 'array') && (
						<button
							className="icon-btn small"
							onClick={() => handleReset(key)}
							title="Reset to default"
						>
							↺
						</button>
					)}
				</div>
			</div>
		)
	}

	if (loading) {
		return (
			<div
				className="panel-col"
				style={{padding: 20, textAlign: 'center'}}
			>
				<div className="muted">Loading settings…</div>
			</div>
		)
	}

	if (!config) {
		return (
			<div
				className="panel-col"
				style={{padding: 20, textAlign: 'center'}}
			>
				<div className="muted">No settings available for this extension</div>
				<button
					className="icon-btn"
					onClick={onClose}
					style={{marginTop: 10}}
				>
					Close
				</button>
			</div>
		)
	}

	return (
		<div className="panel-col">
			<div className="panel-toolbar">
				<span className="panel-title">{config.title || 'Settings'}</span>
				<button
					className="icon-btn"
					onClick={onClose}
					title="Close"
				>
					×
				</button>
			</div>

			<div
				className="tree-wrap"
				style={{flex: 1, overflow: 'auto', padding: '10px'}}
			>
				{Object.entries(config.properties).length === 0 ? (
					<div
						className="muted"
						style={{textAlign: 'center', padding: 20}}
					>
						No configurable settings
					</div>
				) : (
					<div className="settings-form">
						{Object.entries(config.properties).map(([key, prop]) =>
							renderProperty(key, prop),
						)}
					</div>
				)}
			</div>

			<div
				className="settings-footer"
				style={{
					padding: '10px',
					borderTop: '1px solid var(--border)',
					display: 'flex',
					justifyContent: 'flex-end',
					gap: 8,
				}}
			>
				<button
					className="icon-btn"
					onClick={onClose}
				>
					Cancel
				</button>
				<button
					className="save-btn"
					onClick={handleSave}
					disabled={saving}
				>
					{saving ? 'Saving…' : 'Save'}
				</button>
			</div>
		</div>
	)
}
