import React, { useEffect, useState } from 'react';

import { getReviewVisualization } from '../api/client';
import UiIcon from './UiIcon.jsx';

const MASTERY_COLORS = {
  mastered: '#0f766e',
  familiar: '#3b6f9f',
  unfamiliar: '#b45309',
  unreviewed: '#8a8f98',
};

const STATUS_COLORS = {
  overdue: '#b42318',
  due_today: '#b45309',
  due_soon: '#3b6f9f',
  scheduled: '#0f766e',
  new: '#8a8f98',
};

const formatNumber = (value) => new Intl.NumberFormat('zh-CN').format(Number(value) || 0);

const percent = (value) => `${Math.round((Number(value) || 0) * 100)}%`;

const getMaxCount = (items) => Math.max(1, ...items.map((item) => Number(item?.count) || 0));

function DonutChart({ items = [], colors = {}, label = '' }) {
  const total = items.reduce((sum, item) => sum + (Number(item?.count) || 0), 0);
  const segments = items
    .filter((item) => Number(item?.count) > 0)
    .reduce((acc, item) => {
      const count = Number(item.count) || 0;
      const length = total > 0 ? (count / total) * 100 : 0;
      return {
        offset: acc.offset - length,
        values: [
          ...acc.values,
          {
            key: item.key,
            color: colors[item.key] || '#71717a',
            dasharray: `${length} ${100 - length}`,
            dashoffset: acc.offset,
          },
        ],
      };
    }, { offset: 25, values: [] }).values;

  return (
    <div className="visual-donut" aria-label={label}>
      <svg viewBox="0 0 42 42" role="img">
        <circle className="visual-donut-bg" cx="21" cy="21" r="15.915" />
        {segments.map((segment) => (
          <circle
            key={segment.key}
            className="visual-donut-segment"
            cx="21"
            cy="21"
            r="15.915"
            stroke={segment.color}
            strokeDasharray={segment.dasharray}
            strokeDashoffset={segment.dashoffset}
          />
        ))}
      </svg>
      <div className="visual-donut-center">
        <strong>{formatNumber(total)}</strong>
        <span>单词</span>
      </div>
    </div>
  );
}

function MetricCard({ label, value, hint, icon }) {
  return (
    <div className="visual-metric">
      <div className="visual-metric-icon">
        <UiIcon name={icon} size={16} />
      </div>
      <div className="visual-metric-body">
        <span>{label}</span>
        <strong>{formatNumber(value)}</strong>
        {hint ? <em>{hint}</em> : null}
      </div>
    </div>
  );
}

function DistributionCard({ title, items, colors, emptyText = '暂无数据' }) {
  const total = items.reduce((sum, item) => sum + (Number(item?.count) || 0), 0);
  const maxCount = getMaxCount(items);

  return (
    <section className="visual-panel visual-distribution-panel">
      <div className="visual-panel-header">
        <div>
          <h2>{title}</h2>
          <p>{total ? `共 ${formatNumber(total)} 个词条` : emptyText}</p>
        </div>
        <UiIcon name="pie" size={18} />
      </div>
      <div className="visual-distribution-body">
        <DonutChart items={items} colors={colors} label={title} />
        <div className="visual-distribution-list">
          {items.map((item) => {
            const count = Number(item?.count) || 0;
            const ratio = total > 0 ? count / total : 0;
            const width = `${Math.max(2, Math.round((count / maxCount) * 100))}%`;
            return (
              <div className="visual-distribution-row" key={item.key}>
                <div className="visual-row-head">
                  <span className="visual-swatch" style={{ background: colors[item.key] || '#71717a' }} />
                  <span>{item.label}</span>
                  <strong>{formatNumber(count)}</strong>
                </div>
                <div className="visual-progress">
                  <span style={{ width, background: colors[item.key] || '#71717a' }} />
                </div>
                <div className="visual-row-foot">{percent(ratio)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function FeatureShare({ items = [], title, caption }) {
  return (
    <section className="visual-panel">
      <div className="visual-panel-header">
        <div>
          <h2>{title}</h2>
          <p>{caption}</p>
        </div>
        <UiIcon name="target" size={18} />
      </div>
      <div className="visual-feature-grid">
        {items.map((item) => (
          <div className="visual-feature" key={item.key}>
            <div className="visual-feature-head">
              <span>{item.label}</span>
              <strong>{percent(item.ratio)}</strong>
            </div>
            <div className="visual-progress">
              <span style={{ width: `${Math.max(2, Math.round((Number(item.ratio) || 0) * 100))}%` }} />
            </div>
            <em>{formatNumber(item.count)} 个</em>
          </div>
        ))}
      </div>
    </section>
  );
}

function TrendBars({ items = [], title, valueKey = 'count', labelKey = 'date' }) {
  const maxCount = Math.max(1, ...items.map((item) => Number(item?.[valueKey]) || 0));

  return (
    <section className="visual-panel visual-trend-panel">
      <div className="visual-panel-header">
        <div>
          <h2>{title}</h2>
          <p>按时间聚合复习或新增记录</p>
        </div>
        <UiIcon name="trending-up" size={18} />
      </div>
      <div className="visual-trend">
        {items.map((item) => {
          const count = Number(item?.[valueKey]) || 0;
          const height = `${Math.max(4, Math.round((count / maxCount) * 100))}%`;
          return (
            <div className="visual-trend-item" key={item[labelKey]}>
              <div className="visual-trend-track">
                <span style={{ height }} />
              </div>
              <strong>{formatNumber(count)}</strong>
              <em>{String(item[labelKey] || '').slice(-5)}</em>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function getEntryMeta(entry, metaMode) {
  if (metaMode === 'created') {
    return {
      label: '添加时间',
      value: entry.created_at || '未记录',
    };
  }
  return {
    label: entry.review_status_label || entry.mastery_label,
    value: entry.latest_review ? `${entry.latest_review.date} · ${entry.latest_review.score}/5` : (entry.next_review_date || '未复习'),
  };
}

function EntryList({ title, entries = [], emptyText, onOpenVocabularyEntry = null, metaMode = 'review' }) {
  const canOpen = typeof onOpenVocabularyEntry === 'function';

  return (
    <section className="visual-panel visual-entry-panel">
      <div className="visual-panel-header">
        <div>
          <h2>{title}</h2>
          <p>{entries.length ? `${entries.length} 个词条` : emptyText}</p>
        </div>
        <UiIcon name="list" size={18} />
      </div>
      <div className="visual-entry-list">
        {entries.length ? entries.map((entry) => {
          const meta = getEntryMeta(entry, metaMode);
          return (
            <div className="visual-entry" key={`${entry.category}/${entry.file}`}>
              <div className="visual-entry-main">
                <div className="visual-entry-word-row">
                  <strong>{entry.word}</strong>
                  <button
                    type="button"
                    className="visual-entry-jump"
                    onClick={() => onOpenVocabularyEntry?.({
                      category: entry.category,
                      word: entry.word,
                      fileKey: entry.file,
                    })}
                    disabled={!canOpen}
                    title={`跳转到 ${entry.category} / ${entry.file}`}
                    aria-label={`跳转到 ${entry.word}`}
                  >
                    <UiIcon name="external-link" size={15} />
                  </button>
                </div>
                <span>{entry.category} / {entry.file}</span>
              </div>
              <div className="visual-entry-meta">
                <span>{meta.label}</span>
                <em>{meta.value}</em>
              </div>
            </div>
          );
        }) : (
          <div className="visual-empty">{emptyText}</div>
        )}
      </div>
    </section>
  );
}

function CategoryRank({ items = [], selectedCategory = '', onSelect }) {
  const maxTotal = Math.max(1, ...items.map((item) => Number(item?.total) || 0));

  return (
    <section className="visual-panel visual-rank-panel">
      <div className="visual-panel-header">
        <div>
          <h2>目录规模</h2>
          <p>按词条数量排序</p>
        </div>
        <UiIcon name="folder" size={18} />
      </div>
      <div className="visual-rank-list">
        {items.map((item) => {
          const active = selectedCategory === item.category;
          const width = `${Math.max(4, Math.round(((Number(item.total) || 0) / maxTotal) * 100))}%`;
          return (
            <button
              key={item.category}
              type="button"
              className={`visual-rank-item${active ? ' is-active' : ''}`}
              onClick={() => onSelect(active ? '' : item.category)}
            >
              <div className="visual-rank-head">
                <span>{item.category}</span>
                <strong>{formatNumber(item.total)}</strong>
              </div>
              <div className="visual-progress">
                <span style={{ width }} />
              </div>
              <em>今日 {formatNumber(item.today_reviewed)} / 标记 {formatNumber(item.marked)}</em>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export default function VisualizationDashboard({ categories = [], defaultCategory = '', onOpenVocabularyEntry = null }) {
  const [selectedCategory, setSelectedCategory] = useState(String(defaultCategory || '').trim());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setError('');
    });
    getReviewVisualization(selectedCategory)
      .then((nextData) => {
        if (cancelled) return;
        setData(nextData);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || '加载可视化数据失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedCategory]);

  const fromDataCategories = Array.isArray(data?.categories) ? data.categories : [];
  const categoryOptions = [...new Set([...categories, ...fromDataCategories]
    .map((item) => String(item || '').trim())
    .filter(Boolean))];

  const selected = data?.selected || {};
  const overview = data?.overview || {};
  const counts = selected.counts || {};
  const total = Number(counts.total) || 0;
  const mastered = selected.mastery?.find((item) => item.key === 'mastered')?.count || 0;
  const unfamiliar = selected.mastery?.find((item) => item.key === 'unfamiliar')?.count || 0;
  const unreviewed = selected.mastery?.find((item) => item.key === 'unreviewed')?.count || 0;

  return (
    <div className="visual-dashboard">
      <div className="visual-toolbar">
        <div className="visual-heading">
          <div className="visual-title">可视化</div>
          <div className="visual-caption">
            {selectedCategory ? `${selectedCategory} 目录` : '全部目录'} · {data?.generated_at || ''}
          </div>
        </div>
        <div className="visual-controls">
          <label className="visual-select-label">
            目录
            <select value={selectedCategory} onChange={(event) => setSelectedCategory(event.target.value)}>
              <option value="">全部目录</option>
              {categoryOptions.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
          </label>
          <button type="button" className="master-secondary-button" onClick={() => setSelectedCategory('')}>
            全部
          </button>
        </div>
      </div>

      {error ? <div className="visual-message is-error">{error}</div> : null}
      {loading ? <div className="visual-message">正在加载统计数据...</div> : null}

      {!loading && data ? (
        <div className="visual-content">
          <div className="visual-metrics">
            <MetricCard label="总单词" value={total} hint={selectedCategory || '全部目录'} icon="book" />
            <MetricCard label="熟练" value={mastered} hint={total ? percent(mastered / total) : '0%'} icon="check" />
            <MetricCard label="陌生" value={unfamiliar} hint={`未复习 ${formatNumber(unreviewed)}`} icon="target" />
            <MetricCard label="今日复习" value={counts.today_reviewed || 0} hint={`已复习 ${formatNumber(counts.reviewed || 0)}`} icon="calendar" />
          </div>

          <div className="visual-grid visual-grid-main">
            <DistributionCard title="熟练度分布" items={selected.mastery || []} colors={MASTERY_COLORS} />
            <DistributionCard title="复习状态" items={selected.review_status || []} colors={STATUS_COLORS} />
          </div>

          <div className="visual-grid visual-grid-wide">
            <FeatureShare
              title="今日背诵词特征"
              caption={counts.today_reviewed ? '按今天已经打分的词条统计' : '今天还没有复习记录'}
              items={selected.today_feature_share || []}
            />
            <FeatureShare
              title="当前词池特征"
              caption="按选中目录内所有词条统计"
              items={selected.feature_share || []}
            />
          </div>

          <div className="visual-grid visual-grid-wide">
            <TrendBars title="近 14 天复习量" items={overview.daily_review_trend || []} />
            <CategoryRank
              items={overview.category_rank || []}
              selectedCategory={selectedCategory}
              onSelect={setSelectedCategory}
            />
          </div>

          <div className="visual-grid visual-grid-entry">
            <EntryList
              title="优先复习"
              entries={selected.due_entries || []}
              emptyText="当前范围没有到期或新词条"
              onOpenVocabularyEntry={onOpenVocabularyEntry}
            />
            <EntryList
              title="最近复习"
              entries={selected.latest_reviews || []}
              emptyText="当前范围暂无复习记录"
              onOpenVocabularyEntry={onOpenVocabularyEntry}
            />
            <EntryList
              title="最近添加"
              entries={selected.recently_added || []}
              emptyText="当前范围暂无添加记录"
              onOpenVocabularyEntry={onOpenVocabularyEntry}
              metaMode="created"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
