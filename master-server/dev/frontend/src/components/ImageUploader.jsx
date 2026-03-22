import React, { useState } from 'react';
import { uploadImage } from '../api/client';

export default function ImageUploader() {
  const [imageFile, setImageFile] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [llmResult, setLlmResult] = useState('');

  const handleUpload = async () => {
    if (!imageFile) return alert("请先选择图片！");
    
    setStatusMsg("图片上传中并等待 LLM 处理（可能需要十几秒）...");
    setLlmResult('');
    
    const formData = new FormData();
    formData.append('file', imageFile);

    try {
      const data = await uploadImage(formData);
      if (data.status === "success") {
        setStatusMsg(data.message);
        setLlmResult(data.llm_result);
      } else {
        setStatusMsg("处理失败: " + data.error);
      }
    } catch (err) {
      setStatusMsg("上传失败: " + err.message);
    }
  };

  return (
    <>
      <div style={{ padding: '15px', border: '1px solid var(--border)', borderRadius: '8px' }}>
        <h3 style={{ marginTop: 0 }}>数据采集 (Data Acquisition)</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
          <input type="file" accept="image/*" onChange={e => setImageFile(e.target.files[0])} style={{ fontSize: '16px' }} />
          <button onClick={handleUpload} disabled={!imageFile} style={{ padding: '10px', cursor: imageFile ? 'pointer' : 'not-allowed', background: imageFile ? '#28a745' : '#ccc', color: 'white', border: 'none', borderRadius: '4px' }}>
            上传图片并提取生词
          </button>
        </div>
      </div>

      {statusMsg && <p style={{ marginTop: '20px', color: '#d63384', fontWeight: 'bold' }}>{statusMsg}</p>}

      {llmResult && (
        <div style={{ marginTop: '20px', padding: '15px', background: 'var(--code-bg)', border: '1px solid var(--border)', borderRadius: '8px', textAlign: 'left' }}>
          <h4 style={{ marginTop: 0 }}>LLM 提取结果：</h4>
          <pre style={{ whiteSpace: 'pre-wrap', wordWrap: 'break-word', fontSize: '14px', margin: 0, fontFamily: 'var(--mono)' }}>
            {llmResult}
          </pre>
        </div>
      )}
    </>
  );
}