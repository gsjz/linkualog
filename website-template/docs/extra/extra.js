(function() {
    const initTitleTools = () => {
        const titleElement = document.querySelector('h1');

        if (titleElement && !titleElement.querySelector('.title-tools-wrapper')) {
            const titleText = titleElement.innerText.replace('¶', '').trim();
            
            const isPureEnglish = /^[a-zA-Z\s\-\.',!\?]+$/.test(titleText);

            if (isPureEnglish && titleText.length > 0) {
                titleElement.style.position = "relative";
                titleElement.style.paddingRight = "100px"; 

                const wrapper = document.createElement('div');
                wrapper.className = "title-tools-wrapper";
                wrapper.style.cssText = `
                    position: absolute;
                    right: 0;
                    top: 50%;
                    transform: translateY(-50%);
                    display: flex;
                    gap: 15px; 
                    align-items: center;
                    line-height: 1;
                `;

                const applyIconStyle = (link) => {
                    link.style.color = "inherit";
                    link.style.transition = "all 0.2s";
                    link.style.display = "inline-flex";
                    link.style.opacity = "0.4"; 
                    link.onmouseover = () => { link.style.opacity = "1"; link.style.transform = "scale(1.1)"; };
                    link.onmouseout = () => { link.style.opacity = "0.4"; link.style.transform = "scale(1)"; };
                };

                const ttsBtn = document.createElement('a');
                ttsBtn.style.cursor = "pointer";
                ttsBtn.title = `朗读 "${titleText}"`;
                applyIconStyle(ttsBtn);
                ttsBtn.onclick = () => {
                    const m = new SpeechSynthesisUtterance(titleText);
                    m.lang = 'en-US';
                    window.speechSynthesis.speak(m);
                };
                ttsBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="22px" viewBox="0 -960 960 960" width="22px" fill="currentColor"><path d="M560-131v-82q90-26 145-100t55-168q0-94-55-168T560-749v-82q124 28 202 125.5T840-481q0 127-78 224.5T560-131ZM120-360v-240h160l200-200v640L280-360H120Zm440 40v-322q47 22 73.5 66t26.5 96q0 51-26.5 94.5T560-320Z"/></svg>`;

                const youdaoLink = document.createElement('a');
                const encodedText = encodeURIComponent(titleText.toLowerCase());
                youdaoLink.href = `https://www.youdao.com/result?word=${encodedText}&lang=en`;
                youdaoLink.target = "_blank";
                applyIconStyle(youdaoLink);
                youdaoLink.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="22px" viewBox="0 -960 960 960" width="22px" fill="currentColor"><path d="m480-80-40-120H160q-33 0-56.5-23.5T80-280v-520q0-33 23.5-56.5T160-880h240l35 120h365q35 0 57.5 22.5T880-680v520q0 33-22.5 56.5T800-80H480Z"/></svg>`;

                const youglishLink = document.createElement('a');
                youglishLink.href = `https://youglish.com/pronounce/${encodedText}/english`;
                youglishLink.target = "_blank";
                applyIconStyle(youglishLink);
                youglishLink.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="22px" viewBox="0 -960 960 960" width="22px" fill="currentColor"><path d="M240-520h60v-80h-60v80Zm100 80h60v-240h-60v240Zm110 80h60v-400h-60v400Zm110-80h60v-240h-60v240Zm100-80h60v-80h-60v80ZM80-80v-720q0-33 23.5-56.5T160-880h640q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H240L80-80Z"/></svg>`;

                wrapper.appendChild(ttsBtn);
                wrapper.appendChild(youdaoLink);
                wrapper.appendChild(youglishLink);
                titleElement.appendChild(wrapper);
            }
        }
    };

    const observer = new MutationObserver(initTitleTools);
    observer.observe(document.body, { childList: true, subtree: true });
    initTitleTools();
})();