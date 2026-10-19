// src/components/modal/settings/pages/integration/CustomSourceRows.tsx
// The 自定义音源 rows: what is installed, adding one, and what each source can do.
//
// A custom source is a MusicFree-format script. It runs in the main process with that process's
// authority, so the first thing this panel says is what installing one means — the same warning
// the mod panel gives, for the same reason. Nothing is loaded until the listener switches it on.
//
// The list is the main process's answer, not local state: the scripts live there, and every change
// (install, switch, remove, reload) re-reads the list so the panel and the source switcher cannot
// drift apart.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Button, Group, Row, Status, TextArea, TextField, Toggle } from '../../kit';
import { CUSTOM_SOURCE, CUSTOM_SOURCE_OPTIONS } from './customSourceOptions';
import { syncCustomSourceProviders } from '../../../../../services/onlineMusic/customSource/customSourceRegistry';
import {
    getCustomSourceTransportAvailability,
    listCustomSources,
    requestCustomSource,
} from '../../../../../services/onlineMusic/customSource/customSourceTransport';
import type { CustomSourceEntry } from '../../../../../services/onlineMusic/customSource/customSourceTypes';

// src/components/modal/settings/pages/integration/CustomSourceRows.tsx

/** One source's row: its name and state, and the switch that turns it on. */
const SourceRow: React.FC<{
    entry: CustomSourceEntry;
    busy: boolean;
    onToggle: (enabled: boolean) => void;
    onRemove: () => void;
}> = ({ entry, busy, onToggle, onRemove }) => {
    const { t } = useTranslation();
    const [confirmingRemove, setConfirmingRemove] = useState(false);

    // What the source can do, in the host's words. A source with no audio method cannot play, which
    // is worth saying before the listener wonders why nothing happens.
    const abilities = useMemo(() => {
        const methods = new Set(entry.methods);
        const list: string[] = [];
        if (methods.has('search')) list.push(t('options.customSourceAbilitySearch'));
        if (methods.has('getMediaSource')) list.push(t('options.customSourceAbilityPlayback'));
        if (methods.has('getLyric')) list.push(t('options.customSourceAbilityLyrics'));
        if (methods.has('getTopLists')) list.push(t('options.customSourceAbilityTopLists'));
        if (methods.has('getAlbumInfo')) list.push(t('options.customSourceAbilityAlbums'));
        if (methods.has('getArtistWorks')) list.push(t('options.customSourceAbilityArtists'));
        if (methods.has('importMusicSheet')) list.push(t('options.customSourceAbilitySheets'));
        return list;
    }, [entry.methods, t]);

    return (
        <>
            <Row
                label={(
                    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="truncate font-medium">{entry.platform || entry.id}</span>
                        {entry.version && (
                            <span className="text-[11px] text-[color:var(--st-t3)]">v{entry.version}</span>
                        )}
                        {entry.author && (
                            <span className="text-[11px] text-[color:var(--st-t3)]">{entry.author}</span>
                        )}
                    </span>
                )}
                hint={entry.description ?? undefined}
            >
                <div className="flex items-center gap-2">
                    {entry.error && <Status tone="error">{entry.error}</Status>}
                    {!entry.error && entry.enabled && (
                        <Status tone={entry.loadedAt > 0 ? 'ok' : undefined}>
                            {entry.loadedAt > 0 ? t('options.customSourceReady') : t('options.customSourceLoading')}
                        </Status>
                    )}
                    <Toggle checked={entry.enabled} onChange={onToggle} disabled={busy} />
                </div>
            </Row>
            {/* What the script implements. A row of its own so the name row stays short. */}
            <Row sub label={(
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[11px] text-[color:var(--st-t3)]">
                        {abilities.length > 0 ? abilities.join(' · ') : t('options.customSourceNoAbilities')}
                    </span>
                    {entry.homepage && (
                        <a
                            className="text-[11px] text-[color:var(--st-accent)] underline-offset-2 hover:underline"
                            href={entry.homepage}
                            target="_blank"
                            rel="noreferrer noopener"
                        >
                            {t('options.customSourceHomepage')}
                        </a>
                    )}
                </span>
            )}>
                {confirmingRemove ? (
                    <div className="flex items-center gap-2">
                        <Button variant="quiet" onClick={() => setConfirmingRemove(false)}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                           
                           
                            onClick={() => {
                                setConfirmingRemove(false);
                                onRemove();
                            }}
                        >
                            {t('options.customSourceRemoveConfirm')}
                        </Button>
                    </div>
                ) : (
                    <Button
                       
                        variant="quiet"
                        icon={Trash2}
                        tip={t('options.customSourceRemove')}
                        onClick={() => setConfirmingRemove(true)}
                        disabled={busy}
                    />
                )}
            </Row>
        </>
    );
};

const CustomSourceRows: React.FC = () => {
    const { t } = useTranslation();
    const available = getCustomSourceTransportAvailability().configured;
    const [entries, setEntries] = useState<CustomSourceEntry[]>([]);
    const [loading, setLoading] = useState(available);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [installing, setInstalling] = useState(false);
    const [url, setUrl] = useState('');
    const [pasted, setPasted] = useState('');
    const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
    // Guards against a stale read landing after a newer one.
    const readGeneration = useRef(0);

    /** Re-reads the list and re-registers providers, so the source switcher matches the panel. */
    const refresh = useCallback(async () => {
        const generation = ++readGeneration.current;
        const rows = await listCustomSources();
        if (generation !== readGeneration.current) return;
        setEntries(rows);
        setLoading(false);
        // A source's switch changes what the app offers, so the provider registry is re-read here
        // rather than on the next song change.
        await syncCustomSourceProviders().catch(() => undefined);
    }, []);

    useEffect(() => {
        if (!available) {
            setLoading(false);
            return;
        }
        void refresh();
    }, [available, refresh]);

    /*
     * A source can be installed from outside this panel — the Folium API, or a listener's own
     * script — and the settings dialog keeps this group mounted while other tabs are shown. So the
     * list is re-read whenever the window regains focus, which is when a change made elsewhere
     * would have landed. It is one cheap IPC call, and it only runs while this page exists.
     */
    useEffect(() => {
        if (!available) return undefined;
        const onFocus = () => { void refresh(); };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [available, refresh]);

    /** Runs one bridge operation, then re-reads. Failures are shown, never swallowed. */
    const run = useCallback(async (
        id: string | null,
        operation: Parameters<typeof requestCustomSource>[0],
        params: Record<string, unknown>,
        successKey: string,
    ) => {
        setBusyId(id);
        setMessage(null);
        try {
            const answer = await requestCustomSource(operation, params);
            if (!answer.ok) {
                setMessage({ tone: 'error', text: answer.error.message || t('options.customSourceFailed') });
                return false;
            }
            await refresh();
            setMessage({ tone: 'ok', text: t(successKey) });
            return true;
        } catch (error) {
            setMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
            return false;
        } finally {
            setBusyId(null);
        }
    }, [refresh, t]);

    const installFromUrl = useCallback(async () => {
        const target = url.trim();
        if (!target) return;
        setInstalling(true);
        const done = await run(null, 'installFromUrl', { url: target }, 'options.customSourceInstalledOne');
        setInstalling(false);
        if (done) setUrl('');
    }, [run, url]);

    const installFromText = useCallback(async () => {
        const text = pasted.trim();
        if (!text) return;
        setInstalling(true);
        const done = await run(null, 'install', { script: text }, 'options.customSourceInstalledOne');
        setInstalling(false);
        if (done) setPasted('');
    }, [pasted, run]);

    // The web build has no main process to run a script in.
    if (!available) {
        return (
            <Group def={CUSTOM_SOURCE}>
                <Row option={CUSTOM_SOURCE_OPTIONS.installed} hint={t('options.customSourceDesktopOnly')}>
                    <Status>{t('options.customSourceDesktopOnlyShort')}</Status>
                </Row>
            </Group>
        );
    }

    return (
        <Group
            def={CUSTOM_SOURCE}
            action={(
                <Button
                   
                    variant="quiet"
                    icon={RefreshCw}
                    tip={t('options.customSourceReload')}
                    onClick={() => void run(null, 'reload', {}, 'options.customSourceReloaded')}
                    disabled={loading || busyId !== null}
                />
            )}
            foot={message ? <Status tone={message.tone === 'error' ? 'error' : 'ok'}>{message.text}</Status> : undefined}
        >
            {/* What installing one means. Shown before anything is added, not after. */}
            <Row option={CUSTOM_SOURCE_OPTIONS.warning} hint={t('options.customSourceWarningDesc')}>
                <Status tone="warn">{t('options.customSourceWarningShort')}</Status>
            </Row>

            {loading && (
                <Row option={CUSTOM_SOURCE_OPTIONS.installed}>
                    <span className="inline-flex items-center gap-2 text-xs text-[color:var(--st-t3)]">
                        <Loader2 size={14} className="animate-spin" />
                        {t('options.customSourceLoadingList')}
                    </span>
                </Row>
            )}

            {!loading && entries.length === 0 && (
                <Row option={CUSTOM_SOURCE_OPTIONS.installed} hint={t('options.customSourceEmptyDesc')}>
                    <Status>{t('options.customSourceEmpty')}</Status>
                </Row>
            )}

            {!loading && entries.map((entry) => (
                <SourceRow
                    key={entry.id}
                    entry={entry}
                    busy={busyId === entry.id}
                    onToggle={(enabled) => void run(entry.id, 'setEnabled', { id: entry.id, enabled }, enabled
                        ? 'options.customSourceEnabled'
                        : 'options.customSourceDisabled')}
                    onRemove={() => void run(entry.id, 'remove', { id: entry.id }, 'options.customSourceRemoved')}
                />
            ))}

            {/* Adding one. Both ways are full-width rows: a URL field squeezed beside its button
                truncated the address, and a plugin URL is long. */}
            <Row
                option={CUSTOM_SOURCE_OPTIONS.add}
                hint={t('options.customSourceAddUrlDesc')}
                below={(
                    <div className="flex min-w-0 items-center gap-2">
                        <div className="min-w-0 flex-1">
                            <TextField
                                value={url}
                                onChange={setUrl}
                                onCommit={() => void installFromUrl()}
                                placeholder={t('options.customSourceUrlPlaceholder')}
                                disabled={installing}
                                // A plugin URL is long; this field fills the row instead of the
                                // kit's fixed 260px, which truncated it mid-address.
                                widthClassName="w-full"
                            />
                        </div>
                        <Button
                            variant="primary"
                            icon={Download}
                            onClick={() => void installFromUrl()}
                            disabled={installing || !url.trim()}
                        >
                            {installing ? t('options.customSourceInstalling') : t('options.customSourceInstall')}
                        </Button>
                    </div>
                )}
            />

            <Row
                sub
                label={t('options.customSourcePasteHint')}
                below={(
                    <div className="flex w-full min-w-0 flex-col gap-2">
                        <TextArea
                            value={pasted}
                            onChange={setPasted}
                            placeholder={t('options.customSourcePastePlaceholder')}
                            disabled={installing}
                        />
                        <div className="flex justify-end">
                            <Button
                                variant="primary"
                                onClick={() => void installFromText()}
                                disabled={installing || !pasted.trim()}
                            >
                                {t('options.customSourceInstallPasted')}
                            </Button>
                        </div>
                    </div>
                )}
            />
        </Group>
    );
};

export default CustomSourceRows;
