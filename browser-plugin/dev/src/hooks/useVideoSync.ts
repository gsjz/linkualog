import { useState, useEffect, useRef } from 'react';
import { Subtitle } from '../types';
import { IVideoAdapter } from '../adapters/BaseAdapter';

export function useVideoSync(subs: Subtitle[], adapter: IVideoAdapter) {
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const activeIndexRef = useRef<number>(-1);

  useEffect(() => {
    if (subs.length === 0) return;
    let syncReq: number;
    let lastTime = -1;

    const syncSubs = () => {
      const rawTime = adapter.getCurrentTime();
      
      if (rawTime === lastTime) {
        syncReq = requestAnimationFrame(syncSubs);
        return;
      }
      lastTime = rawTime;

      const currentTime = rawTime + 0.05; 

      const currentIdx = activeIndexRef.current;
      const tolerance = 0.2; 
      
      if (currentIdx >= 0 && currentIdx < subs.length) {
        if (currentIdx + 1 < subs.length) {
          const nextSub = subs[currentIdx + 1];
          if (currentTime >= nextSub.start && currentTime <= nextSub.end + tolerance) {
            activeIndexRef.current = currentIdx + 1;
            setActiveIndex(currentIdx + 1);
            syncReq = requestAnimationFrame(syncSubs);
            return;
          }
        }
        
        const sub = subs[currentIdx];
        if (currentTime >= sub.start && currentTime <= sub.end + tolerance) {
          syncReq = requestAnimationFrame(syncSubs);
          return;
        }
      }

      let left = 0;
      let right = subs.length - 1;
      let foundIdx = -1;
      
      while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        if (subs[mid].start <= currentTime) {
          foundIdx = mid; 
          left = mid + 1; 
        } else {
          right = mid - 1;
        }
      }

      if (foundIdx !== -1) {
        const sub = subs[foundIdx];
        if (currentTime > sub.end + tolerance) {
          foundIdx = -1; 
        }
      }

      if (foundIdx !== currentIdx) {
        activeIndexRef.current = foundIdx;
        setActiveIndex(foundIdx);
      }

      syncReq = requestAnimationFrame(syncSubs);
    };

    syncReq = requestAnimationFrame(syncSubs);
    return () => cancelAnimationFrame(syncReq);
  }, [subs, adapter]);

  return activeIndex;
}