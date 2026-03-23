import React, { useState, useEffect } from 'react';
import { uploadResource, getTaskStatus, resumeTask, getAllTasks, deleteTask, getImageUrl, regenerateTaskPage } from '../api/client';

export default function TaskVisualizer() {
  const [historyTasks, setHistoryTasks] = useState([]);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [taskData, setTaskData] = useState(null);

  const [files, setFiles] = useState([]);
  const [taskName, setTaskName] = useState('');
  const [startPage, setStartPage] = useState(1);
  const [isUploading, setIsUploading] = useState(false);
  const [regeneratingPages, setRegeneratingPages] = useState({});

  const fetchTasksList = async () => {
    try {
      const data = await getAllTasks();
      if (data.tasks) setHistoryTasks(data.tasks);
    } catch (e) { }
  };

  useEffect(() => {
    fetchTasksList();
    const listInterval = setInterval(fetchTasksList, 10000);
    return () => clearInterval(listInterval);
  }, []);

  useEffect(() => {
    let detailInterval;
    if (selectedTaskId && taskData?.status !== 'finished' && taskData?.status !== 'paused') {
      detailInterval = setInterval(async () => {
        try {
          const data = await getTaskStatus(selectedTaskId);
          setTaskData(data);
          fetchTasksList();
        } catch (error) { }
      }, 5000); 
    }
    return () => clearInterval(detailInterval);
  }, [selectedTaskId, taskData?.status]);

  const handleSelectTask = async (taskId) => {
    setSelectedTaskId(taskId);
    setTaskData(null);
    const data = await getTaskStatus(taskId);
    setTaskData(data);
  };

  const handleDeleteTask = async () => {
    if (window.confirm("确定要永久删除该任务及记录吗？")) {
      await deleteTask(selectedTaskId);
      setSelectedTaskId(null);
      setTaskData(null);
      fetchTasksList();
    }
  };

  const handleUpload = async () => {
    if (files.length === 0) return alert("请先选择文件！");
    setIsUploading(true);
    try {
      const formData = new FormData();
      for (let f of files) formData.append('files', f);
      
      formData.append('taskName', taskName);
      formData.append('startPage', startPage);

      const result = await uploadResource(formData);
      await fetchTasksList();
      handleSelectTask(result.task_id);
      setFiles([]);
      setTaskName('');
    } catch (e) {
      alert("上传失败: " + e.message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleResume = async () => {
    await resumeTask(selectedTaskId);
    setTaskData({...taskData, status: 'processing'});
    fetchTasksList();
  };

  const handleRegenerate = async (index) => {
    if (!selectedTaskId) return;
    setRegeneratingPages(prev => ({ ...prev, [index]: true }));
    try {
      await regenerateTaskPage(selectedTaskId, index);
      const data = await getTaskStatus(selectedTaskId);
      setTaskData(data);
    } catch (error) {
      alert("重新生成请求失败: " + error.message);
    } finally {
      setRegeneratingPages(prev => ({ ...prev, [index]: false }));
    }
  };

  const getFormattedResults = () => {
    if (!taskData || !taskData.sub_tasks) return [];
    
    const finalTaskName = taskData.name || '未命名任务';
    const basePage = taskData.start_page !== undefined ? parseInt(taskData.start_page, 10) : 1;

    return taskData.sub_tasks.map((sub, index) => {
      let extractedContent = sub.result;
      if (sub.result) {
        try {
          const jsonMatch = sub.result.match(/```json\n([\s\S]*?)\n```/);
          if (jsonMatch) extractedContent = JSON.parse(jsonMatch[1]);
          else extractedContent = JSON.parse(sub.result);
        } catch (e) {}
      }
      return {
        task_name: finalTaskName,
        page_number: basePage + index,
        content: extractedContent,
        status: sub.status,
        image_path: sub.path,
        error: sub.error 
      };
    });
  };

  const renderJsonValue = (val) => {
    if (typeof val === 'string') {
      if (val.includes('\n')) {
        return (
          <div style={{ 
            color: '#0550ae', whiteSpace: 'pre-wrap', wordBreak: 'break-word', 
            padding: '8px 12px', background: '#f3f4f6', borderRadius: '4px', 
            marginTop: '4px', marginBottom: '4px', fontFamily: 'system-ui, sans-serif',
            borderLeft: '3px solid #d1d5db'
          }}>
            {val}
          </div>
        );
      }
      return <span style={{ color: '#0550ae', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>"{val}"</span>;
    }
    if (typeof val === 'number' || typeof val === 'boolean') {
      return <span style={{ color: '#cf222e' }}>{String(val)}</span>;
    }
    if (Array.isArray(val)) {
      return (
        <div style={{ marginLeft: '16px', marginTop: '4px' }}>
          {val.map((item, i) => <div key={i} style={{ marginBottom: '4px' }}>- {renderJsonValue(item)}</div>)}
        </div>
      );
    }
    if (typeof val === 'object' && val !== null) {
      return (
        <div style={{ marginLeft: '16px', marginTop: '4px' }}>
          {Object.entries(val).map(([k, v]) => (
            <div key={k} style={{ marginBottom: '4px' }}>
              <strong style={{ color: '#24292f' }}>{k}: </strong>
              {renderJsonValue(v)}
            </div>
          ))}
        </div>
      );
    }
    return null;
  };

  const getStatusText = (status) => {
    if (status === 'finished') return <span style={{ color: '#10b981' }}>完成</span>;
    if (status === 'processing') return <span style={{ color: '#3b82f6' }}>处理中</span>;
    if (status === 'paused') return <span style={{ color: '#ef4444' }}>失败/暂停</span>;
    return <span style={{ color: '#71717a' }}>等待中</span>;
  };

  const inputClass = {
    padding: '6px 12px', border: '1px solid #e4e4e7', borderRadius: '4px', 
    fontSize: '13px', outline: 'none', background: '#fff'
  };

  return (
    <div className="task-layout" style={{ display: 'flex', height: '100%', width: '100%' }}>
      
      <div className="task-sidebar" style={{ width: '280px', borderRight: '1px solid #e4e4e7', background: '#fafafa', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #e4e4e7', fontSize: '12px', fontWeight: '600', color: '#71717a' }}>
          历史任务
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {historyTasks.map(task => {
            const isSelected = selectedTaskId === task.id;
            return (
              <div 
                key={task.id} 
                onClick={() => handleSelectTask(task.id)}
                style={{ 
                  padding: '12px 16px', 
                  borderBottom: '1px solid #e4e4e7',
                  cursor: 'pointer',
                  background: isSelected ? '#e4e4e7' : 'transparent',
                }}
              >
                <div style={{ fontSize: '13px', fontWeight: isSelected ? '600' : '400', color: '#09090b', marginBottom: '4px', wordBreak: 'break-all' }}>
                  {task.name}
                </div>
                <div style={{ fontSize: '12px', color: '#71717a', display: 'flex', justifyContent: 'space-between' }}>
                  <span>{task.completed} / {task.total}</span>
                  {getStatusText(task.status)}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="task-main-area" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, background: '#ffffff' }}>
        
        <div className="task-toolbar" style={{ padding: '16px 24px', borderBottom: '1px solid #e4e4e7', display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '13px', fontWeight: '600', color: '#09090b' }}>新建任务:</span>
          <input type="text" placeholder="任务名称 (选填)" value={taskName} onChange={e => setTaskName(e.target.value)} style={{ ...inputClass, width: '200px' }} />
          <span style={{ fontSize: '13px', color: '#71717a' }}>起始页:</span>
          <input type="number" min="1" value={startPage} onChange={e => setStartPage(e.target.value)} style={{ ...inputClass, width: '80px' }} />
          <input type="file" multiple accept="image/*,application/pdf" onChange={e => setFiles(e.target.files)} style={{ fontSize: '13px', marginLeft: '12px' }} />
          
          <button 
            onClick={handleUpload} 
            disabled={isUploading}
            style={{ 
              padding: '6px 16px', background: isUploading ? '#e4e4e7' : '#18181b', 
              color: isUploading ? '#71717a' : '#fff', border: '1px solid transparent', 
              borderRadius: '4px', fontSize: '13px', cursor: isUploading ? 'not-allowed' : 'pointer',
              marginLeft: 'auto'
            }}
          >
            {isUploading ? '处理中...' : '开始处理'}
          </button>
        </div>

        {taskData ? (
          <div className="task-detail-wrapper" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
            <div className="task-status-bar" style={{ padding: '12px 24px', borderBottom: '1px solid #e4e4e7', background: '#fafafa', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: '13px', color: '#09090b', display: 'flex', alignItems: 'center', gap: '16px' }}>
                <strong style={{ fontSize: '14px' }}>{taskData.name}</strong>
                <span>进度: {taskData.completed} / {taskData.total}</span>
                <span>状态: {getStatusText(taskData.status)}</span>
              </div>
              <div style={{ display: 'flex', gap: '12px' }}>
                {taskData.status === 'paused' && (
                  <button onClick={handleResume} style={{ padding: '4px 12px', background: '#fff', border: '1px solid #e4e4e7', borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}>从失败处继续</button>
                )}
                <button onClick={handleDeleteTask} style={{ padding: '4px 12px', background: '#fff', color: '#ef4444', border: '1px solid #fca5a5', borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}>删除任务</button>
              </div>
            </div>

            <div style={{ height: '2px', background: '#e4e4e7', width: '100%', flexShrink: 0 }}>
              <div style={{ width: `${(taskData.completed / taskData.total) * 100}%`, height: '100%', background: taskData.status === 'paused' ? '#ef4444' : '#18181b', transition: 'width 0.3s' }} />
            </div>

            <div className="task-content-area" style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
              {getFormattedResults().map((item, idx) => {
                 const isRegenerating = regeneratingPages[idx];
                 return (
                 <div key={idx} className="result-item-container" style={{ marginBottom: '32px', border: '1px solid #e4e4e7', borderRadius: '6px', overflow: 'hidden' }}>
                    
                    <div style={{ padding: '8px 16px', background: '#fafafa', borderBottom: '1px solid #e4e4e7', fontSize: '12px', color: '#71717a', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: '500', color: '#09090b' }}>页码: {item.page_number}</span>
                        <span>状态: {item.status === 'completed' ? '解析成功' : item.status === 'failed' ? '解析失败' : '处理中...'}</span>
                        
                        {item.error && (
                          <span style={{ color: '#ef4444', fontSize: '12px', background: '#fee2e2', padding: '4px 8px', borderRadius: '4px', maxWidth: '400px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={item.error}>
                            原因: {item.error}
                          </span>
                        )}
                      </div>
                      
                      <button 
                        onClick={() => handleRegenerate(idx)}
                        disabled={isRegenerating || item.status === 'processing'}
                        style={{ 
                          padding: '4px 10px', 
                          background: '#fff', 
                          border: '1px solid #e4e4e7', 
                          borderRadius: '4px', 
                          fontSize: '12px', 
                          cursor: (isRegenerating || item.status === 'processing') ? 'not-allowed' : 'pointer',
                          color: (isRegenerating || item.status === 'processing') ? '#a1a1aa' : '#09090b',
                          transition: 'all 0.2s',
                          flexShrink: 0
                        }}
                      >
                        {isRegenerating ? '🔄 请求中...' : '🔄 重新生成'}
                      </button>
                    </div>

                    <div className="result-layout" style={{ display: 'flex' }}>
                      <div className="result-image-box" style={{ width: '350px', borderRight: '1px solid #e4e4e7', padding: '16px', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <img 
                          src={getImageUrl(item.image_path)} 
                          alt={`第 ${item.page_number} 页预览`} 
                          style={{ maxWidth: '100%', maxHeight: '500px', objectFit: 'contain' }}
                          onError={(e) => { 
                            e.target.style.display = 'none'; 
                            e.target.parentElement.innerHTML = '<span style="color:#a1a1aa;font-size:12px;">图片不可用</span>'; 
                          }}
                        />
                      </div>
                      
                      <div className="result-json-box" style={{ flex: 1, padding: '16px', background: '#fafafa', overflowX: 'auto', fontSize: '13px', lineHeight: '1.6', fontFamily: 'ui-monospace, Consolas, monospace' }}>
                        {item.status === 'failed' ? (
                          <div style={{ color: '#ef4444', padding: '10px', background: '#fee2e2', borderRadius: '4px' }}>
                            <strong>错误详情:</strong> {item.error}
                          </div>
                        ) : item.content ? (
                          typeof item.content === 'object' 
                            ? renderJsonValue(item.content) 
                            : <pre style={{ whiteSpace: 'pre-wrap', color: '#24292f', margin: 0, fontFamily: 'inherit' }}>{item.content}</pre>
                        ) : (
                          <div style={{ color: '#a1a1aa' }}>等待处理...</div>
                        )}
                      </div>
                    </div>

                 </div>
                 );
              })}
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a1a1aa', fontSize: '14px' }}>
            请在左侧选择一个任务查看，或在上方新建任务。
          </div>
        )}
      </div>
    </div>
  );
}