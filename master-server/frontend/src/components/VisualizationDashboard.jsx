import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

const GRAPH_EDGE_TYPE_COLORS = {
  related: '#64748b',
  same_word: '#0f766e',
  phrase: '#2563eb',
  variant: '#7c3aed',
  collocation: '#0891b2',
  synonym: '#16a34a',
  antonym: '#dc2626',
  same_category: '#b45309',
  same_scene: '#be123c',
};
const GRAPH_EDGE_FALLBACK_COLORS = ['#0f766e', '#2563eb', '#b45309', '#7c3aed', '#be123c', '#0891b2', '#4d7c0f', '#dc2626'];

const GRAPH_COMPONENT_COLORS = ['#0f766e', '#3b6f9f', '#b45309', '#7c3aed', '#be123c', '#4d7c0f'];
const GRAPH_NODE_DOUBLE_CLICK_MS = 420;
const GRAPH_CURRENT_NODE_FILL = '#fff7ed';
const GRAPH_CURRENT_NODE_STROKE = '#f97316';
const GRAPH_MIN_ZOOM = 0.45;
const GRAPH_MAX_ZOOM = 3;
const GRAPH_ZOOM_STEP = 1.22;
const GRAPH_INITIAL_VIEWPORT = Object.freeze({ scale: 1, x: 0, y: 0 });

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

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function clampGraphViewportTransform(transform, dimensions = {}) {
  const scale = clamp(Number(transform?.scale) || 1, GRAPH_MIN_ZOOM, GRAPH_MAX_ZOOM);
  const width = Math.max(320, Number(dimensions?.width) || 320);
  const height = Math.max(132, Number(dimensions?.height) || 132);
  const horizontalLimit = width * Math.max(1.25, scale + 0.5);
  const verticalLimit = height * Math.max(1.25, scale + 0.5);
  return {
    scale,
    x: clamp(Number(transform?.x) || 0, -horizontalLimit, horizontalLimit),
    y: clamp(Number(transform?.y) || 0, -verticalLimit, verticalLimit),
  };
}

function hashString(value) {
  return String(value || '').split('').reduce((hash, char) => (
    ((hash << 5) - hash + char.charCodeAt(0)) | 0
  ), 0);
}

function normalizeGraphEdgeType(value) {
  return String(value || 'related').trim().toLowerCase().replace(/[\s-]+/g, '_') || 'related';
}

function getGraphEdgeTypeColor(type) {
  const normalizedType = normalizeGraphEdgeType(type);
  if (GRAPH_EDGE_TYPE_COLORS[normalizedType]) return GRAPH_EDGE_TYPE_COLORS[normalizedType];
  return GRAPH_EDGE_FALLBACK_COLORS[Math.abs(hashString(normalizedType)) % GRAPH_EDGE_FALLBACK_COLORS.length];
}

function formatGraphEdgeTypeLabel(type) {
  const normalizedType = normalizeGraphEdgeType(type);
  return {
    related: '相关',
    same_word: '同词',
    phrase: '短语',
    variant: '变体',
    collocation: '搭配',
    synonym: '近义',
    antonym: '反义',
    same_category: '同类',
    same_scene: '同场景',
  }[normalizedType] || normalizedType.replace(/_/g, ' ');
}

function buildGraphEdgeTypeLegend(edges, limit = 6) {
  const typeCounts = new Map();
  (Array.isArray(edges) ? edges : []).forEach((edge) => {
    const type = normalizeGraphEdgeType(edge?.type);
    typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
  });

  const items = [...typeCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], undefined, { sensitivity: 'base' }))
    .slice(0, limit)
    .map(([type]) => ({
      type,
      label: formatGraphEdgeTypeLabel(type),
      color: getGraphEdgeTypeColor(type),
    }));

  return items.length ? items : [{
    type: 'related',
    label: formatGraphEdgeTypeLabel('related'),
    color: getGraphEdgeTypeColor('related'),
  }];
}

function truncateGraphLabel(value, limit = 16) {
  const text = String(value || '').trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function getGraphComponentId(component, index = 0) {
  return String(component?.id || `component-${index + 1}`).trim() || `component-${index + 1}`;
}

function buildSingleComponentGraph(graph, component, index = 0) {
  const id = getGraphComponentId(component, index);
  const nodes = Array.isArray(component?.nodes) ? component.nodes : [];
  const edges = Array.isArray(component?.edges) ? component.edges : [];
  return {
    ...graph,
    scope: {
      ...(graph?.scope || {}),
      label: `块${index + 1}`,
    },
    nodes,
    edges,
    components: [
      {
        ...component,
        id,
        nodes,
        edges,
      },
    ],
    component_count: 1,
    connected_node_count: nodes.length,
  };
}

function summarizeGraphComponent(component, index = 0) {
  const nodes = Array.isArray(component?.nodes) ? component.nodes : [];
  const edges = Array.isArray(component?.edges) ? component.edges : [];
  const categories = Array.isArray(component?.categories)
    ? component.categories.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const sampleWords = nodes
    .map((node) => String(node?.word || node?.file || '').trim())
    .filter(Boolean)
    .slice(0, 3);
  return {
    id: getGraphComponentId(component, index),
    nodeCount: Number(component?.node_count || component?.nodeCount || nodes.length) || nodes.length,
    edgeCount: Number(component?.edge_count || component?.edgeCount || edges.length) || edges.length,
    categories,
    sampleWords,
  };
}

function buildRelationGraphModel(components) {
  const nodeById = new Map();
  const edgeByKey = new Map();
  const summaries = [];

  components.forEach((component, componentIndex) => {
    const componentId = getGraphComponentId(component, componentIndex);
    const componentNodes = Array.isArray(component.nodes) ? component.nodes : [];
    const componentNodeIds = new Set(componentNodes.map((node) => String(node?.id || '')).filter(Boolean));

    componentNodes.forEach((node) => {
      const id = String(node?.id || '').trim();
      if (!id) return;
      nodeById.set(id, {
        ...node,
        id,
        componentId,
        componentIndex,
        color: GRAPH_COMPONENT_COLORS[componentIndex % GRAPH_COMPONENT_COLORS.length],
      });
    });

    (Array.isArray(component.edges) ? component.edges : []).forEach((edge) => {
      const source = String(edge?.source || '').trim();
      const target = String(edge?.target || '').trim();
      if (!source || !target || !componentNodeIds.has(source) || !componentNodeIds.has(target)) return;
      const type = normalizeGraphEdgeType(edge?.type);
      const key = `${source}|${target}|${type}`;
      if (edgeByKey.has(key)) return;
      edgeByKey.set(key, {
        ...edge,
        source,
        target,
        type,
        scope: edge.scope === 'cross_category' ? 'cross_category' : 'same_category',
        componentId,
        componentIndex,
      });
    });

    summaries.push({
      id: componentId,
      componentIndex,
      nodeCount: componentNodes.length,
      edgeCount: Number(component.edge_count || component.edges?.length || 0),
      categories: Array.isArray(component.categories) ? component.categories : [],
      color: GRAPH_COMPONENT_COLORS[componentIndex % GRAPH_COMPONENT_COLORS.length],
    });
  });

  const degreeById = new Map();
  edgeByKey.forEach((edge) => {
    degreeById.set(edge.source, (degreeById.get(edge.source) || 0) + 1);
    degreeById.set(edge.target, (degreeById.get(edge.target) || 0) + 1);
  });

  const nodes = [...nodeById.values()]
    .filter((node) => degreeById.has(node.id) || edgeByKey.size === 0)
    .map((node) => {
      const labelLength = String(node.word || node.file || '').length;
      return {
        ...node,
        degree: degreeById.get(node.id) || 0,
        boxWidth: clamp(64 + labelLength * 4.5, 72, 118),
        boxHeight: 32,
      };
    });
  const liveNodeIds = new Set(nodes.map((node) => node.id));
  const edges = [...edgeByKey.values()].filter((edge) => liveNodeIds.has(edge.source) && liveNodeIds.has(edge.target));

  return {
    nodes,
    edges,
    summaries: summaries.filter((summary) => nodes.some((node) => node.componentId === summary.id)),
    key: `${nodes.map((node) => node.id).join(',')}|${edges.map((edge) => `${edge.source}-${edge.target}-${edge.type}`).join(',')}`,
  };
}

function estimateGraphColumns(width, count) {
  if (width <= 640) return 1;
  if (width < 1280) return Math.min(2, count);
  return Math.min(3, count);
}

function estimateComponentZoneHeight(summary, compact = false) {
  const nodeCount = Math.max(2, Number(summary?.nodeCount) || 2);
  const edgeCount = Math.max(1, Number(summary?.edgeCount) || 1);
  if (compact) {
    return Math.max(132, 68 + nodeCount * 20 + edgeCount * 5);
  }
  return Math.max(180, 120 + nodeCount * 24 + edgeCount * 6);
}

function estimateGraphHeight(summaries, width, compactMode = false) {
  const items = Array.isArray(summaries) ? summaries : [];
  if (compactMode) {
    if (!items.length) return width <= 640 ? 132 : 148;
    if (items.length === 1) {
      const summary = items[0];
      const nodeCount = Math.max(2, Number(summary?.nodeCount) || 2);
      const edgeCount = Math.max(1, Number(summary?.edgeCount) || 1);
      return Math.max(width <= 640 ? 132 : 148, Math.min(260, 70 + nodeCount * 18 + edgeCount * 5));
    }
  }
  if (!items.length) return width <= 640 ? 340 : 420;
  const compact = width <= 640;
  if (compact) {
    return 18 + items.reduce((sum, summary) => sum + estimateComponentZoneHeight(summary, true), 0) + Math.max(0, items.length - 1) * 20 + 18;
  }

  const columns = estimateGraphColumns(width, items.length);
  const rows = Math.ceil(items.length / columns);
  let total = 22;
  for (let row = 0; row < rows; row += 1) {
    const rowItems = items.slice(row * columns, row * columns + columns);
    total += Math.max(...rowItems.map((summary) => estimateComponentZoneHeight(summary, false)));
    if (row < rows - 1) total += 20;
  }
  total += 22;
  return Math.max(420, total);
}

function buildGraphZones(summaries, width, height) {
  const count = Math.max(1, summaries.length);
  const zones = new Map();
  if (count === 1) {
    const id = summaries[0]?.id || 'component-1';
    zones.set(id, {
      id,
      x: 12,
      y: 12,
      width: Math.max(1, width - 24),
      height: Math.max(1, height - 24),
      cx: width / 2,
      cy: height / 2,
    });
    return zones;
  }

  const compact = width <= 640;
  if (compact) {
    let y = 18;
    summaries.forEach((summary) => {
      const zoneHeight = estimateComponentZoneHeight(summary, true);
      zones.set(summary.id, {
        id: summary.id,
        x: 10,
        y,
        width: Math.max(1, width - 20),
        height: zoneHeight,
        cx: width / 2,
        cy: y + zoneHeight / 2,
      });
      y += zoneHeight + 20;
    });
    return zones;
  }

  const columns = estimateGraphColumns(width, count);
  const rows = Math.ceil(count / columns);
  const gapX = 16;
  const gapY = 20;
  const usableWidth = width - 24 - gapX * (columns - 1);
  const zoneWidth = usableWidth / columns;
  const rowHeights = [];
  for (let row = 0; row < rows; row += 1) {
    const rowItems = summaries.slice(row * columns, row * columns + columns);
    rowHeights.push(Math.max(...rowItems.map((summary) => estimateComponentZoneHeight(summary, false))));
  }

  let y = 22;
  rowHeights.forEach((rowHeight, row) => {
    for (let col = 0; col < columns; col += 1) {
      const summary = summaries[row * columns + col];
      if (!summary) continue;
      const x = 12 + col * (zoneWidth + gapX);
      zones.set(summary.id, {
        id: summary.id,
        x,
        y,
        width: zoneWidth,
        height: rowHeight,
        cx: x + zoneWidth / 2,
        cy: y + rowHeight / 2,
      });
    }
    y += rowHeight + gapY;
  });
  return zones;
}

function buildGraphAnchors(zones) {
  const anchors = new Map();
  zones.forEach((zone, id) => {
    anchors.set(id, {
      x: zone.cx,
      y: zone.cy,
    });
  });
  return anchors;
}

function clampNodeToZone(node, zone, dimensions, padding = 6) {
  const halfWidth = node.boxWidth / 2;
  const halfHeight = node.boxHeight / 2;
  const bounds = zone
    ? {
        minX: zone.x + halfWidth + padding,
        maxX: zone.x + zone.width - halfWidth - padding,
        minY: zone.y + halfHeight + padding,
        maxY: zone.y + zone.height - halfHeight - padding,
      }
    : {
        minX: halfWidth + 8,
        maxX: dimensions.width - halfWidth - 8,
        minY: halfHeight + 8,
        maxY: dimensions.height - halfHeight - 8,
      };
  if (bounds.minX > bounds.maxX) {
    node.x = zone ? zone.cx : dimensions.width / 2;
  } else {
    node.x = clamp(node.x, bounds.minX, bounds.maxX);
  }
  if (bounds.minY > bounds.maxY) {
    node.y = zone ? zone.cy : dimensions.height / 2;
  } else {
    node.y = clamp(node.y, bounds.minY, bounds.maxY);
  }
}

function setNodePositionInZone(node, x, y, zone, dimensions, padding = 6) {
  node.x = x;
  node.y = y;
  clampNodeToZone(node, zone, dimensions, padding);
  return {
    x: node.x,
    y: node.y,
  };
}

function snapshotLayoutNodes(nodes) {
  return nodes.map((node) => ({
    id: node.id,
    x: node.x,
    y: node.y,
    boxWidth: node.boxWidth,
    boxHeight: node.boxHeight,
    word: node.word,
    category: node.category,
    file: node.file,
    color: node.color,
    componentId: node.componentId,
    degree: node.degree,
  }));
}

function stepForceLayout(nodes, edges, anchors, zones, dimensions, alpha) {
  const { width, height } = dimensions;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  edges.forEach((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) return;
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const desired = edge.scope === 'cross_category' ? 112 : 88;
    const force = (distance - desired) * 0.028 * alpha;
    const fx = (dx / distance) * force;
    const fy = (dy / distance) * force;
    source.vx += fx;
    source.vy += fy;
    target.vx -= fx;
    target.vy -= fy;
  });

  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const left = nodes[i];
      const right = nodes[j];
      if (left.componentId !== right.componentId) continue;
      let dx = right.x - left.x;
      let dy = right.y - left.y;
      let distance = Math.hypot(dx, dy);
      if (distance < 1) {
        const jitter = hashString(`${left.id}-${right.id}`) || 1;
        dx = jitter % 7;
        dy = jitter % 11;
        distance = Math.max(1, Math.hypot(dx, dy));
      }
      const minDistance = (left.boxWidth + right.boxWidth) * 0.34 + 10;
      const charge = Math.min(4.6, 3900 / (distance * distance)) * alpha;
      const overlap = distance < minDistance ? (minDistance - distance) * 0.018 * alpha : 0;
      const force = charge + overlap;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      left.vx -= fx;
      left.vy -= fy;
      right.vx += fx;
      right.vy += fy;
    }
  }

  nodes.forEach((node) => {
    const anchor = anchors.get(node.componentId) || { x: width / 2, y: height / 2 };
    node.vx += (anchor.x - node.x) * 0.0038 * alpha;
    node.vy += (anchor.y - node.y) * 0.0038 * alpha;
    node.vx *= 0.93;
    node.vy *= 0.93;

    if (Number.isFinite(node.fx) && Number.isFinite(node.fy)) {
      node.x = node.fx;
      node.y = node.fy;
      node.vx = 0;
      node.vy = 0;
    } else {
      node.x += node.vx;
      node.y += node.vy;
    }

    const beforeX = node.x;
    const beforeY = node.y;
    clampNodeToZone(node, zones.get(node.componentId), dimensions);
    if (node.x !== beforeX) node.vx *= -0.54;
    if (node.y !== beforeY) node.vy *= -0.54;
  });
}

function RelationGraphPreview({ graph = {}, index = 0 }) {
  const graphComponents = graph?.components;
  const components = useMemo(() => (
    Array.isArray(graphComponents) ? graphComponents : []
  ), [graphComponents]);
  const model = useMemo(() => buildRelationGraphModel(components), [components]);
  const width = 286;
  const height = 126;
  const nodes = useMemo(() => {
    const count = Math.max(1, model.nodes.length);
    const centerX = width / 2;
    const centerY = height / 2;
    const radiusX = Math.min(98, 36 + count * 8);
    const radiusY = Math.min(38, 20 + count * 3);
    return model.nodes.map((node, nodeIndex) => {
      const seed = Math.abs(hashString(`${node.id}-${index}`));
      const angle = count === 1
        ? 0
        : ((nodeIndex / count) * Math.PI * 2) + ((seed % 36) * Math.PI / 180);
      const label = truncateGraphLabel(node.word || node.file, 10);
      const labelWidth = clamp(34 + label.length * 5.7, 52, 90);
      return {
        ...node,
        label,
        labelWidth,
        x: clamp(centerX + Math.cos(angle) * radiusX, labelWidth / 2 + 12, width - labelWidth / 2 - 12),
        y: clamp(centerY + Math.sin(angle) * radiusY, 20, height - 17),
      };
    });
  }, [index, model.nodes]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const labeledNodes = nodes.slice(0, 12);

  return (
    <svg
      className="visual-graph-preview"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`块${index + 1}预览`}
    >
      <rect className="visual-graph-preview-bg" x="8" y="8" width={width - 16} height={height - 16} rx="8" />
      <g>
        {model.edges.slice(0, 16).map((edge, edgeIndex) => {
          const source = nodeById.get(edge.source);
          const target = nodeById.get(edge.target);
          if (!source || !target) return null;
          return (
            <line
              key={`${edge.source}-${edge.target}-${edgeIndex}`}
              className={`visual-graph-preview-link ${edge.scope === 'cross_category' ? 'is-cross' : 'is-same'}`}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              stroke={getGraphEdgeTypeColor(edge.type)}
            />
          );
        })}
      </g>
      <g>
        {nodes.slice(0, 18).map((node) => (
          <circle
            key={node.id}
            className="visual-graph-preview-node"
            cx={node.x}
            cy={node.y}
            r={Math.max(4, Math.min(8, 5 + node.degree))}
          />
        ))}
      </g>
      <g>
        {labeledNodes.map((node) => (
          <g
            key={`${node.id}-label`}
            className="visual-graph-preview-label"
            transform={`translate(${node.x} ${node.y})`}
          >
            <rect
              className="visual-graph-preview-label-bg"
              x={-node.labelWidth / 2}
              y="-9"
              width={node.labelWidth}
              height="18"
              rx="5"
            />
            <text className="visual-graph-preview-label-text" y="3" textAnchor="middle">
              {node.label}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

export function RelationGraphPanel({
  graph = {},
  onOpenVocabularyEntry = null,
  title = '关系图',
  emptyDescription = '暂无关系',
  emptyMessage = '无连接',
  focusNodeId = '',
  currentNodeId = '',
  compact = false,
  className = '',
  openNodeOnClick = false,
  deckMode = false,
  fitContainerHeight = false,
  onRefreshGraph = null,
  graphRefreshing = false,
}) {
  const components = useMemo(() => (
    Array.isArray(graph?.components) ? graph.components : []
  ), [graph?.components]);
  const canOpen = typeof onOpenVocabularyEntry === 'function';
  const model = useMemo(() => buildRelationGraphModel(components), [components]);
  const nodeById = useMemo(() => new Map(model.nodes.map((node) => [node.id, node])), [model.nodes]);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [canvasWidth, setCanvasWidth] = useState(760);
  const [canvasHeight, setCanvasHeight] = useState(420);
  const [layoutNodes, setLayoutNodes] = useState([]);
  const [viewportTransform, setViewportTransform] = useState(GRAPH_INITIAL_VIEWPORT);
  const [graphPanning, setGraphPanning] = useState(false);
  const viewportRef = useRef(null);
  const svgRef = useRef(null);
  const simNodesRef = useRef([]);
  const simEdgesRef = useRef([]);
  const anchorsRef = useRef(new Map());
  const zonesRef = useRef(new Map());
  const dimensionsRef = useRef({ width: 760, height: 420 });
  const alphaRef = useRef(0);
  const frameRef = useRef(null);
  const dragRef = useRef(null);
  const previousFocusNodeIdRef = useRef('');
  const deckViewportRef = useRef(null);
  const pointerSelectionRef = useRef(null);
  const lastNodeClickRef = useRef({ id: '', time: 0 });
  const graphPointersRef = useRef(new Map());
  const pinchRef = useRef(null);
  const panRef = useRef(null);
  const viewportTransformRef = useRef(GRAPH_INITIAL_VIEWPORT);
  const [selectedComponentId, setSelectedComponentId] = useState('');

  const graphHeight = useMemo(() => {
    if (fitContainerHeight) {
      const minHeight = compact ? 132 : 340;
      return Math.max(minHeight, canvasHeight);
    }
    return estimateGraphHeight(model.summaries, canvasWidth, compact);
  }, [canvasHeight, canvasWidth, compact, fitContainerHeight, model.summaries]);

  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) : null;
  const selectedEdges = selectedNode
    ? model.edges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id)
    : [];
  const selectedNeighbors = selectedEdges.map((edge) => {
    const neighborId = edge.source === selectedNode?.id ? edge.target : edge.source;
    return {
      edge,
      node: nodeById.get(neighborId),
    };
  }).filter((item) => item.node);
  const deckSummaries = useMemo(() => (
    components.map((component, index) => summarizeGraphComponent(component, index))
  ), [components]);
  const canRefreshGraph = typeof onRefreshGraph === 'function';
  const selectedComponentIndex = Math.max(0, deckSummaries.findIndex((summary) => summary.id === selectedComponentId));
  const selectedDeckComponent = deckMode && deckSummaries.length
    ? components[selectedComponentIndex] || components[0]
    : null;

  useEffect(() => {
    if (!deckMode || !deckSummaries.length) return;
    if (deckSummaries.some((summary) => summary.id === selectedComponentId)) return;
    setSelectedComponentId(deckSummaries[0].id);
  }, [deckMode, deckSummaries, selectedComponentId]);

  const openVocabularyNode = useCallback((node) => {
    if (!canOpen || !node) return;
    onOpenVocabularyEntry({
      category: node.category,
      word: node.word,
      fileKey: node.file,
    });
  }, [canOpen, onOpenVocabularyEntry]);

  const normalizedCurrentNodeId = String(currentNodeId || '').trim();

  const handleNodeClick = useCallback((node) => {
    const nodeId = String(node?.id || '').trim();
    if (!nodeId) return;
    const suppressClickUntil = Number(pointerSelectionRef.current?.suppressClickUntil) || 0;
    if (suppressClickUntil && performance.now() <= suppressClickUntil) {
      pointerSelectionRef.current = null;
      return;
    }
    const now = performance.now();
    const lastClick = lastNodeClickRef.current;
    const rapidSecondClick = lastClick?.id === nodeId
      && now - (Number(lastClick.time) || 0) <= GRAPH_NODE_DOUBLE_CLICK_MS;
    lastNodeClickRef.current = { id: nodeId, time: now };
    pointerSelectionRef.current = null;
    setSelectedNodeId(nodeId);
    if (openNodeOnClick && rapidSecondClick && normalizedCurrentNodeId !== nodeId) {
      openVocabularyNode(node);
    }
  }, [normalizedCurrentNodeId, openNodeOnClick, openVocabularyNode]);

  const handleDeckSelect = useCallback((componentId) => {
    setSelectedComponentId(componentId);
    queueMicrotask(() => {
      const viewport = deckViewportRef.current;
      const target = viewport?.querySelector(`[data-component-id="${CSS.escape(componentId)}"]`);
      target?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    });
  }, []);

  const runSimulation = useCallback(function tick() {
    const nodes = simNodesRef.current;
    if (!nodes.length) {
      frameRef.current = null;
      return;
    }
    const dragging = Boolean(dragRef.current);
    if (alphaRef.current <= 0.01 && !dragging) {
      frameRef.current = null;
      return;
    }

    stepForceLayout(nodes, simEdgesRef.current, anchorsRef.current, zonesRef.current, dimensionsRef.current, alphaRef.current);
    alphaRef.current = dragging ? Math.max(alphaRef.current * 0.97, 0.32) : alphaRef.current * 0.965;
    setLayoutNodes(snapshotLayoutNodes(nodes));
    frameRef.current = window.requestAnimationFrame(tick);
  }, []);

  const ensureSimulation = useCallback(() => {
    if (!frameRef.current) {
      frameRef.current = window.requestAnimationFrame(runSimulation);
    }
  }, [runSimulation]);

  const getViewportPointFromClient = useCallback((clientX, clientY) => {
    const svg = svgRef.current;
    const rect = svg?.getBoundingClientRect();
    const dimensions = dimensionsRef.current;
    if (!rect || !rect.width || !rect.height) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * dimensions.width,
      y: ((clientY - rect.top) / rect.height) * dimensions.height,
    };
  }, []);

  const applyViewportTransform = useCallback((nextTransform) => {
    const normalizedTransform = clampGraphViewportTransform(
      typeof nextTransform === 'function'
        ? nextTransform(viewportTransformRef.current)
        : nextTransform,
      dimensionsRef.current,
    );
    viewportTransformRef.current = normalizedTransform;
    setViewportTransform(normalizedTransform);
    return normalizedTransform;
  }, []);

  const zoomGraphAtPoint = useCallback((viewportPoint, scaleFactor) => {
    if (!viewportPoint || !Number.isFinite(scaleFactor) || scaleFactor <= 0) return;
    applyViewportTransform((previousTransform) => {
      const previousScale = previousTransform.scale || 1;
      const nextScale = clamp(previousScale * scaleFactor, GRAPH_MIN_ZOOM, GRAPH_MAX_ZOOM);
      if (Math.abs(nextScale - previousScale) < 0.001) return previousTransform;
      const graphX = (viewportPoint.x - (previousTransform.x || 0)) / previousScale;
      const graphY = (viewportPoint.y - (previousTransform.y || 0)) / previousScale;
      return {
        scale: nextScale,
        x: viewportPoint.x - graphX * nextScale,
        y: viewportPoint.y - graphY * nextScale,
      };
    });
  }, [applyViewportTransform]);

  const handleViewportZoomButton = useCallback((scaleFactor) => {
    const dimensions = dimensionsRef.current;
    zoomGraphAtPoint({ x: dimensions.width / 2, y: dimensions.height / 2 }, scaleFactor);
  }, [zoomGraphAtPoint]);

  const resetViewportTransform = useCallback(() => {
    applyViewportTransform(GRAPH_INITIAL_VIEWPORT);
  }, [applyViewportTransform]);

  const graphPointFromEvent = useCallback((event) => {
    const viewportPoint = getViewportPointFromClient(event.clientX, event.clientY);
    const dimensions = dimensionsRef.current;
    const transform = viewportTransformRef.current;
    if (!viewportPoint) return null;
    const scale = transform.scale || 1;
    return {
      x: clamp((viewportPoint.x - (transform.x || 0)) / scale, 0, dimensions.width),
      y: clamp((viewportPoint.y - (transform.y || 0)) / scale, 0, dimensions.height),
    };
  }, [getViewportPointFromClient]);

  const getPinchMetrics = useCallback(() => {
    const pointers = [...graphPointersRef.current.values()];
    if (pointers.length < 2) return null;
    const first = pointers[0];
    const second = pointers[1];
    const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
    const center = getViewportPointFromClient(
      (first.clientX + second.clientX) / 2,
      (first.clientY + second.clientY) / 2,
    );
    if (!center) return null;
    return {
      distance: Math.max(1, distance),
      center,
    };
  }, [getViewportPointFromClient]);

  const cancelNodeDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    const simNode = simNodesRef.current.find((item) => item.id === drag.id);
    if (simNode) {
      simNode.fx = null;
      simNode.fy = null;
    }
    dragRef.current = null;
    alphaRef.current = Math.max(alphaRef.current, 0.72);
    ensureSimulation();
  }, [ensureSimulation]);

  const startPinchZoom = useCallback((metrics) => {
    if (!metrics) return;
    pointerSelectionRef.current = { suppressClickUntil: performance.now() + 420 };
    panRef.current = null;
    setGraphPanning(false);
    cancelNodeDrag();
    pinchRef.current = {
      distance: metrics.distance,
      center: metrics.center,
      transform: viewportTransformRef.current,
    };
  }, [cancelNodeDrag]);

  const handleGraphPointerDown = useCallback((event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    graphPointersRef.current.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY,
    });
    if (graphPointersRef.current.size >= 2) {
      event.preventDefault();
      startPinchZoom(getPinchMetrics());
      return;
    }

    const target = event.target;
    const nodeTarget = target instanceof Element
      ? target.closest('.visual-force-node')
      : null;
    if (nodeTarget) return;

    const startPoint = getViewportPointFromClient(event.clientX, event.clientY);
    if (!startPoint) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    panRef.current = {
      pointerId: event.pointerId,
      startPoint,
      transform: viewportTransformRef.current,
    };
    setGraphPanning(true);
  }, [getPinchMetrics, getViewportPointFromClient, startPinchZoom]);

  const stopGraphPan = useCallback(() => {
    if (!panRef.current) return false;
    panRef.current = null;
    setGraphPanning(false);
    return true;
  }, []);

  const handleGraphPanMove = useCallback((event) => {
    const pan = panRef.current;
    if (!pan || (event.pointerId != null && pan.pointerId !== event.pointerId)) return false;
    const point = getViewportPointFromClient(event.clientX, event.clientY);
    if (!point) return false;
    event.preventDefault?.();
    const baseTransform = pan.transform || GRAPH_INITIAL_VIEWPORT;
    applyViewportTransform({
      ...baseTransform,
      x: (baseTransform.x || 0) + point.x - pan.startPoint.x,
      y: (baseTransform.y || 0) + point.y - pan.startPoint.y,
    });
    return true;
  }, [applyViewportTransform, getViewportPointFromClient]);

  const handleGraphWheel = useCallback((event) => {
    event.preventDefault();
    const viewportPoint = getViewportPointFromClient(event.clientX, event.clientY);
    if (!viewportPoint) return;
    const deltaUnit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 240 : 1;
    const scaleFactor = Math.exp(-event.deltaY * deltaUnit * 0.001);
    zoomGraphAtPoint(viewportPoint, scaleFactor);
  }, [getViewportPointFromClient, zoomGraphAtPoint]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return undefined;
    const updateSize = () => {
      const rect = node.getBoundingClientRect();
      setCanvasWidth(Math.max(320, Math.round(rect.width || 760)));
      if (fitContainerHeight) {
        setCanvasHeight(Math.max(compact ? 132 : 340, Math.round(rect.height || 0)));
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [compact, fitContainerHeight]);

  useEffect(() => {
    const normalizedFocusNodeId = String(focusNodeId || '').trim();
    if (previousFocusNodeIdRef.current === normalizedFocusNodeId) return;
    previousFocusNodeIdRef.current = normalizedFocusNodeId;
    if (normalizedFocusNodeId && nodeById.has(normalizedFocusNodeId)) {
      setSelectedNodeId(normalizedFocusNodeId);
    }
  }, [focusNodeId, nodeById]);

  useEffect(() => {
    if (!selectedNodeId || nodeById.has(selectedNodeId)) return;
    const normalizedFocusNodeId = String(focusNodeId || '').trim();
    setSelectedNodeId(normalizedFocusNodeId && nodeById.has(normalizedFocusNodeId) ? normalizedFocusNodeId : '');
  }, [focusNodeId, nodeById, selectedNodeId]);

  useEffect(() => {
    const width = Math.max(320, canvasWidth);
    const height = graphHeight;
    const zones = buildGraphZones(model.summaries, width, height);
    const anchors = buildGraphAnchors(zones);
    const simNodes = model.nodes.map((node) => {
      const anchor = anchors.get(node.componentId) || { x: width / 2, y: height / 2 };
      const zone = zones.get(node.componentId);
      const seed = Math.abs(hashString(node.id));
      const angle = (seed % 360) * (Math.PI / 180);
      const radius = Math.min(54, 24 + (seed % 60));
      const simNode = {
        ...node,
        x: anchor.x + Math.cos(angle) * radius,
        y: anchor.y + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
      };
      clampNodeToZone(simNode, zone, { width, height });
      return simNode;
    });

    dimensionsRef.current = { width, height };
    zonesRef.current = zones;
    anchorsRef.current = anchors;
    simNodesRef.current = simNodes;
    simEdgesRef.current = model.edges;
    alphaRef.current = 0.92;
    setLayoutNodes(simNodes);
    ensureSimulation();
  }, [canvasWidth, ensureSimulation, graphHeight, model.edges, model.key, model.nodes, model.summaries]);

  useEffect(() => {
    graphPointersRef.current.clear();
    pinchRef.current = null;
    panRef.current = null;
    pointerSelectionRef.current = null;
    dragRef.current = null;
    setGraphPanning(false);
    applyViewportTransform(GRAPH_INITIAL_VIEWPORT);
  }, [applyViewportTransform, canvasWidth, graphHeight, model.key]);

  useEffect(() => () => {
    if (frameRef.current) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const handleNodePointerDown = useCallback((event, node) => {
    if (
      pinchRef.current
      || (graphPointersRef.current.size > 0 && !graphPointersRef.current.has(event.pointerId))
    ) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = graphPointFromEvent(event);
    if (!point) return;
    pointerSelectionRef.current = {
      id: node.id,
      wasSelected: selectedNodeId === node.id,
    };
    setSelectedNodeId(node.id);
    const simNode = simNodesRef.current.find((item) => item.id === node.id);
    const originX = Number.isFinite(simNode?.x) ? simNode.x : point.x;
    const originY = Number.isFinite(simNode?.y) ? simNode.y : point.y;
    dragRef.current = {
      id: node.id,
      pointerId: event.pointerId,
      offsetX: originX - point.x,
      offsetY: originY - point.y,
      lastX: originX,
      lastY: originY,
      lastTime: performance.now(),
      vx: 0,
      vy: 0,
    };
    if (simNode) {
      const position = setNodePositionInZone(
        simNode,
        originX,
        originY,
        zonesRef.current.get(simNode.componentId),
        dimensionsRef.current,
        2,
      );
      simNode.fx = position.x;
      simNode.fy = position.y;
      dragRef.current.lastX = position.x;
      dragRef.current.lastY = position.y;
    }
    setLayoutNodes(snapshotLayoutNodes(simNodesRef.current));
    alphaRef.current = 0.95;
    ensureSimulation();
  }, [ensureSimulation, graphPointFromEvent, selectedNodeId]);

  const handleGraphPointerMove = useCallback((event) => {
    if (graphPointersRef.current.has(event.pointerId)) {
      graphPointersRef.current.set(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY,
      });
      if (graphPointersRef.current.size >= 2) {
        event.preventDefault?.();
        const metrics = getPinchMetrics();
        if (!pinchRef.current) {
          startPinchZoom(metrics);
        }
        const pinch = pinchRef.current;
        if (metrics && pinch) {
          const baseTransform = pinch.transform || GRAPH_INITIAL_VIEWPORT;
          const baseScale = baseTransform.scale || 1;
          const nextScale = clamp(
            baseScale * (metrics.distance / Math.max(1, pinch.distance)),
            GRAPH_MIN_ZOOM,
            GRAPH_MAX_ZOOM,
          );
          const graphX = (pinch.center.x - (baseTransform.x || 0)) / baseScale;
          const graphY = (pinch.center.y - (baseTransform.y || 0)) / baseScale;
          applyViewportTransform({
            scale: nextScale,
            x: metrics.center.x - graphX * nextScale,
            y: metrics.center.y - graphY * nextScale,
          });
        }
        return;
      }
    }
    if (handleGraphPanMove(event)) return;
    const drag = dragRef.current;
    if (!drag || (event.pointerId != null && drag.pointerId != null && drag.pointerId !== event.pointerId)) return;
    event.preventDefault?.();
    const point = graphPointFromEvent(event);
    if (!point) return;
    const simNode = simNodesRef.current.find((item) => item.id === drag.id);
    if (!simNode) return;
    const now = performance.now();
    const position = setNodePositionInZone(
      simNode,
      point.x + (drag.offsetX || 0),
      point.y + (drag.offsetY || 0),
      zonesRef.current.get(simNode.componentId),
      dimensionsRef.current,
      2,
    );
    const elapsed = Math.max(16, now - (drag.lastTime || now));
    drag.vx = ((position.x - drag.lastX) / elapsed) * 16;
    drag.vy = ((position.y - drag.lastY) / elapsed) * 16;
    drag.lastX = position.x;
    drag.lastY = position.y;
    drag.lastTime = now;
    simNode.fx = position.x;
    simNode.fy = position.y;
    setLayoutNodes(snapshotLayoutNodes(simNodesRef.current));
    alphaRef.current = Math.max(alphaRef.current, 0.78);
    ensureSimulation();
  }, [applyViewportTransform, ensureSimulation, getPinchMetrics, graphPointFromEvent, handleGraphPanMove, startPinchZoom]);

  const handleGraphPointerUp = useCallback((event) => {
    const wasPinching = graphPointersRef.current.size >= 2 || Boolean(pinchRef.current);
    if (graphPointersRef.current.has(event.pointerId)) {
      graphPointersRef.current.delete(event.pointerId);
    }
    if (graphPointersRef.current.size < 2) {
      pinchRef.current = null;
    }
    if (wasPinching) {
      event.preventDefault?.();
    }
    const pan = panRef.current;
    if (pan && (event.pointerId == null || pan.pointerId === event.pointerId)) {
      stopGraphPan();
      event.preventDefault?.();
      return;
    }
    const drag = dragRef.current;
    if (!drag || (event.pointerId != null && drag.pointerId != null && drag.pointerId !== event.pointerId)) return;
    event.preventDefault?.();
    const simNode = simNodesRef.current.find((item) => item.id === drag.id);
    if (simNode) {
      simNode.fx = null;
      simNode.fy = null;
      simNode.vx += clamp(drag.vx || 0, -22, 22) * 0.82;
      simNode.vy += clamp(drag.vy || 0, -22, 22) * 0.82;
    }
    dragRef.current = null;
    alphaRef.current = Math.max(alphaRef.current, 0.9);
    ensureSimulation();
  }, [ensureSimulation, stopGraphPan]);

  useEffect(() => {
    window.addEventListener('pointermove', handleGraphPointerMove, { passive: false });
    window.addEventListener('pointerup', handleGraphPointerUp, { passive: false });
    window.addEventListener('pointercancel', handleGraphPointerUp, { passive: false });
    return () => {
      window.removeEventListener('pointermove', handleGraphPointerMove);
      window.removeEventListener('pointerup', handleGraphPointerUp);
      window.removeEventListener('pointercancel', handleGraphPointerUp);
    };
  }, [handleGraphPointerMove, handleGraphPointerUp]);

  if (!components.length) {
    return (
      <section className={`visual-panel visual-graph-panel${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`}>
        <div className="visual-panel-header">
          <div>
            <h2>{title}</h2>
            <p>{emptyDescription}</p>
          </div>
          <div className="visual-graph-header-actions">
            {canRefreshGraph ? (
              <button
                type="button"
                className="visual-graph-refresh-button"
                onClick={onRefreshGraph}
                disabled={graphRefreshing}
                title="随机换一批关系块"
                aria-label="随机换一批关系块"
              >
                <UiIcon name="shuffle" size={15} />
                <span>{graphRefreshing ? '换取中' : '换一批'}</span>
              </button>
            ) : null}
            <UiIcon name="chart" size={18} />
          </div>
        </div>
        <div className="visual-empty visual-graph-empty">{emptyMessage}</div>
      </section>
    );
  }

  if (deckMode) {
    const activeIndex = selectedComponentIndex >= 0 ? selectedComponentIndex : 0;
    const activeSummary = deckSummaries[activeIndex] || deckSummaries[0];
    const activeComponent = selectedDeckComponent || components[0];
    const activeGraph = activeComponent ? buildSingleComponentGraph(graph, activeComponent, activeIndex) : { components: [] };
  const scopeLabel = graph?.scope?.label || graph?.scope?.category || '全部目录';
  const edgeTypeLegend = buildGraphEdgeTypeLegend(model.edges);

  return (
      <section className={`visual-panel visual-graph-panel visual-graph-deck-panel${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`}>
        <div className="visual-panel-header">
          <div>
            <h2>{title}</h2>
            <p>{scopeLabel} · {components.length}块 · {formatNumber(model.nodes.length)}词</p>
          </div>
          <div className="visual-graph-header-actions">
            <div className="visual-graph-legend" aria-label="边类型颜色说明">
              {edgeTypeLegend.map((item) => (
                <span key={item.type}><i style={{ background: item.color }} />{item.label}</span>
              ))}
              <span><i className="cross-category" />跨目录虚线</span>
            </div>
            {canRefreshGraph ? (
              <button
                type="button"
                className="visual-graph-refresh-button"
                onClick={onRefreshGraph}
                disabled={graphRefreshing}
                title="随机换一批关系块"
                aria-label="随机换一批关系块"
              >
                <UiIcon name="shuffle" size={15} />
                <span>{graphRefreshing ? '换取中' : '换一批'}</span>
              </button>
            ) : null}
          </div>
        </div>

        <div className="visual-graph-deck-layout">
          <aside className="visual-graph-deck-sidebar" aria-label="关系块预览">
            <div className="visual-graph-deck-list" ref={deckViewportRef}>
              {components.map((component, index) => {
                const summary = deckSummaries[index] || summarizeGraphComponent(component, index);
                const selected = summary.id === activeSummary?.id;
                const previewGraph = buildSingleComponentGraph(graph, component, index);
                return (
                  <button
                    key={summary.id}
                    type="button"
                    className={`visual-graph-component-card${selected ? ' is-selected' : ''}`}
                    data-component-id={summary.id}
                    onClick={() => handleDeckSelect(summary.id)}
                    aria-pressed={selected}
                  >
                    <div className="visual-graph-component-meta">
                      <strong>块{index + 1}</strong>
                      <span>{formatNumber(summary.nodeCount)}词 · {formatNumber(summary.edgeCount)}线</span>
                    </div>
                    <RelationGraphPreview graph={previewGraph} index={index} />
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="visual-graph-deck-detail">
            {activeSummary ? (
              <div className="visual-graph-expanded-card">
                <div className="visual-graph-expanded-head">
                  <div>
                    <strong>块{activeIndex + 1}</strong>
                    <span>{formatNumber(activeSummary.nodeCount)}词 · {formatNumber(activeSummary.edgeCount)}线</span>
                  </div>
                </div>
                <RelationGraphPanel
                  graph={activeGraph}
                  onOpenVocabularyEntry={onOpenVocabularyEntry}
                  title={`块${activeIndex + 1}`}
                  currentNodeId={currentNodeId}
                  className="visual-graph-expanded-panel"
                  openNodeOnClick
                />
              </div>
            ) : null}
          </div>
        </div>
      </section>
    );
  }

  const placedById = new Map(layoutNodes.map((node) => [node.id, node]));
  const width = Math.max(320, canvasWidth);
  const height = graphHeight;
  const scopeLabel = graph?.scope?.label || graph?.scope?.category || '全部目录';
  const zones = [...zonesRef.current.values()];
  const summaryById = new Map(model.summaries.map((summary) => [summary.id, summary]));
  const edgeTypeLegend = buildGraphEdgeTypeLegend(model.edges);
  const zoomLevel = `${Math.round((viewportTransform.scale || 1) * 100)}%`;
  const viewportTransformValue = `translate(${viewportTransform.x} ${viewportTransform.y}) scale(${viewportTransform.scale})`;

  return (
    <section className={`visual-panel visual-graph-panel${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`}>
      <div className="visual-panel-header">
        <div>
          <h2>{title}</h2>
          <p>{scopeLabel} · {components.length}块 · {formatNumber(model.nodes.length)}词</p>
        </div>
        <div className="visual-graph-header-actions">
          <div className="visual-graph-legend" aria-label="边类型颜色说明">
            {edgeTypeLegend.map((item) => (
              <span key={item.type}><i style={{ background: item.color }} />{item.label}</span>
            ))}
            <span><i className="cross-category" />跨目录虚线</span>
          </div>
          {canRefreshGraph ? (
            <button
              type="button"
              className="visual-graph-refresh-button"
              onClick={onRefreshGraph}
              disabled={graphRefreshing}
              title="随机换一批关系块"
              aria-label="随机换一批关系块"
            >
              <UiIcon name="shuffle" size={15} />
              <span>{graphRefreshing ? '换取中' : '换一批'}</span>
            </button>
          ) : null}
        </div>
      </div>
      <div className="visual-graph-workspace">
        <div className={`visual-graph-canvas${graphPanning ? ' is-panning' : ''}`} ref={viewportRef}>
          <svg
            ref={svgRef}
            className="visual-force-graph"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`${scopeLabel} 词条关系图`}
            onPointerDown={handleGraphPointerDown}
            onWheel={handleGraphWheel}
          >
            <g className="visual-force-viewport" transform={viewportTransformValue}>
              <g className="visual-force-zones">
                {zones.map((zone, index) => {
                  const summary = summaryById.get(zone.id);
                  return (
                    <g key={zone.id}>
                      <rect
                        x={zone.x}
                        y={zone.y}
                        width={zone.width}
                        height={zone.height}
                        rx="8"
                        fill={summary?.color || GRAPH_COMPONENT_COLORS[index % GRAPH_COMPONENT_COLORS.length]}
                      />
                      <text x={zone.x + 9} y={zone.y + 18} className="visual-force-zone-label">
                        {`块${index + 1} · ${summary?.nodeCount || 0}`}
                      </text>
                    </g>
                  );
                })}
              </g>
              <g className="visual-force-links">
                {model.edges.map((edge, edgeIndex) => {
                  const source = placedById.get(edge.source);
                  const target = placedById.get(edge.target);
                  if (!source || !target) return null;
                  const scope = edge.scope === 'cross_category' ? 'cross_category' : 'same_category';
                  return (
                    <line
                      key={`${edge.source}-${edge.target}-${edge.type}-${edgeIndex}`}
                      className={`visual-force-link ${scope === 'cross_category' ? 'is-cross' : 'is-same'}`}
                      x1={source.x}
                      y1={source.y}
                      x2={target.x}
                      y2={target.y}
                      stroke={getGraphEdgeTypeColor(edge.type)}
                    />
                  );
                })}
              </g>
              <g className="visual-force-nodes">
                {layoutNodes.map((node) => {
                  const selected = selectedNodeId === node.id;
                  const current = normalizedCurrentNodeId === node.id;
                  return (
                    <g
                      key={node.id}
                      className={`visual-force-node${selected ? ' is-selected' : ''}${current ? ' is-current' : ''}`}
                      transform={`translate(${node.x} ${node.y})`}
                      role="button"
                      tabIndex={0}
                      aria-label={`${node.word} ${node.category}`}
                      onPointerDown={(event) => handleNodePointerDown(event, node)}
                      onClick={() => handleNodeClick(node)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          handleNodeClick(node);
                        }
                      }}
                    >
                      <rect
                        x={-node.boxWidth / 2}
                        y={-node.boxHeight / 2}
                        width={node.boxWidth}
                        height={node.boxHeight}
                        rx="8"
                        fill={current ? GRAPH_CURRENT_NODE_FILL : '#fff'}
                        stroke={current ? GRAPH_CURRENT_NODE_STROKE : (selected ? '#111827' : node.color)}
                      />
                      <text className="visual-force-node-word" y="-2" textAnchor="middle">
                        {truncateGraphLabel(node.word || node.file)}
                      </text>
                      <text className="visual-force-node-category" y="11" textAnchor="middle">
                        {node.category}
                      </text>
                    </g>
                  );
                })}
              </g>
            </g>
          </svg>
          <div className="visual-graph-zoom-controls" aria-label="关系图缩放">
            <button
              type="button"
              className="visual-graph-zoom-button"
              onClick={() => handleViewportZoomButton(1 / GRAPH_ZOOM_STEP)}
              disabled={viewportTransform.scale <= GRAPH_MIN_ZOOM + 0.01}
              title="缩小"
              aria-label="缩小关系图"
            >
              <UiIcon name="zoom-out" size={14} />
            </button>
            <button
              type="button"
              className="visual-graph-zoom-reset"
              onClick={resetViewportTransform}
              title="重置缩放"
              aria-label={`重置关系图缩放，当前 ${zoomLevel}`}
            >
              <UiIcon name="refresh" size={13} />
              <span>{zoomLevel}</span>
            </button>
            <button
              type="button"
              className="visual-graph-zoom-button"
              onClick={() => handleViewportZoomButton(GRAPH_ZOOM_STEP)}
              disabled={viewportTransform.scale >= GRAPH_MAX_ZOOM - 0.01}
              title="放大"
              aria-label="放大关系图"
            >
              <UiIcon name="zoom-in" size={14} />
            </button>
          </div>
        </div>

        <aside className="visual-graph-inspector">
          {selectedNode ? (
            <>
              <div className="visual-graph-inspector-head">
                <span>选中</span>
                <strong>{selectedNode.word}</strong>
                <em>{selectedNode.category} / {selectedNode.file}</em>
              </div>
              <div className="visual-graph-inspector-meta">
                <span>{selectedNode.review_status_label || selectedNode.review_status || '未复习'}</span>
                <span>{selectedEdges.length}边</span>
                <span>{selectedNode.mastery_label || '未评分'}</span>
              </div>
              <button
                type="button"
                className="visual-graph-jump"
                onClick={() => openVocabularyNode(selectedNode)}
                disabled={!canOpen}
              >
                <UiIcon name="external-link" size={15} />
                <span>打开</span>
              </button>
              <div className="visual-graph-neighbors">
                <span>邻接</span>
                {selectedNeighbors.map(({ node, edge }) => (
                  <button
                    key={`${selectedNode.id}-${node.id}-${edge.type}`}
                    type="button"
                    onClick={() => setSelectedNodeId(node.id)}
                    className={`visual-graph-neighbor ${edge.scope === 'cross_category' ? 'is-cross' : 'is-same'}`}
                  >
                    <strong>{node.word}</strong>
                    <em>{edge.type} · {edge.scope === 'cross_category' ? '跨目录' : '同目录'}</em>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="visual-graph-inspector-empty">
              <strong>点选节点</strong>
              <span>显示邻接词。</span>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

export default function VisualizationDashboard({ categories = [], defaultCategory = '', onOpenVocabularyEntry = null }) {
  const [selectedCategory, setSelectedCategory] = useState(String(defaultCategory || '').trim());
  const [graphRequest, setGraphRequest] = useState({ random: false, seed: '' });
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
    getReviewVisualization(selectedCategory, {
      graphLimit: 5,
      graphRandom: graphRequest.random,
      graphSeed: graphRequest.seed,
    })
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
  }, [graphRequest.random, graphRequest.seed, selectedCategory]);

  const handleSelectCategory = useCallback((nextCategory) => {
    setSelectedCategory(String(nextCategory || '').trim());
    setGraphRequest({ random: false, seed: '' });
  }, []);

  const handleRefreshGraph = useCallback(() => {
    setGraphRequest({
      random: true,
      seed: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
  }, []);

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
  const graphRefreshing = loading && graphRequest.random;
  const showContent = Boolean(data && (!loading || graphRefreshing));

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
            <select value={selectedCategory} onChange={(event) => handleSelectCategory(event.target.value)}>
              <option value="">全部目录</option>
              {categoryOptions.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
          </label>
          <button type="button" className="master-secondary-button" onClick={() => handleSelectCategory('')}>
            全部
          </button>
        </div>
      </div>

      {error ? <div className="visual-message is-error">{error}</div> : null}
      {loading ? <div className="visual-message">{graphRefreshing ? '正在换取关系图...' : '正在加载统计数据...'}</div> : null}

      {showContent ? (
        <div className="visual-content">
          <RelationGraphPanel
            graph={data.graph || {}}
            onOpenVocabularyEntry={onOpenVocabularyEntry}
            title="推荐关系图"
            deckMode
            onRefreshGraph={handleRefreshGraph}
            graphRefreshing={graphRefreshing}
          />

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
              onSelect={handleSelectCategory}
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
