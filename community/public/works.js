const workFields = document.querySelector('[data-work-fields]');

if (workFields) {
  const workForm = workFields.closest('form');
  const categorySelect = workForm.querySelector('select[name="category"]');
  const coverInput = workFields.querySelector('[data-cover-input]');
  const coverId = workFields.querySelector('input[name="coverId"]');
  const coverImage = workFields.querySelector('[data-cover-preview]');
  const placeholder = workFields.querySelector('[data-cover-placeholder]');
  const coverStatus = workFields.querySelector('[data-cover-status]');
  const coverReset = workFields.querySelector('[data-cover-reset]');
  const cropX = workFields.querySelector('input[name="cropX"]');
  const cropY = workFields.querySelector('input[name="cropY"]');
  const cropZoom = workFields.querySelector('input[name="cropZoom"]');
  const coverKey = `buildme:work-cover:${workForm.dataset.userId}:${workForm.dataset.editorId}`;
  const coverUrls = new Map();
  const recovery = document.createElement('div');
  recovery.className = 'form-actions cover-recovery';
  recovery.hidden = true;
  const retryCover = document.createElement('button');
  retryCover.type = 'button';
  retryCover.className = 'button';
  retryCover.textContent = '重试上传';
  const cancelCover = document.createElement('button');
  cancelCover.type = 'button';
  cancelCover.className = 'button';
  cancelCover.textContent = '取消这次上传';
  recovery.append(retryCover, cancelCover);
  coverStatus.after(recovery);
  let coverRequest;
  let uploadingCover = false;
  let failedCover = false;
  let selectedFile;

  function setCoverStatus(message, error = false) {
    coverStatus.textContent = message;
    coverStatus.classList.toggle('field-error', error);
    coverStatus.setAttribute('role', error ? 'alert' : 'status');
  }

  function isStoredImage(url) {
    const origin = new URL(url, location.origin).origin;
    return origin === location.origin || origin === document.documentElement.dataset.imageOrigin;
  }

  if (coverId.value && coverImage.getAttribute('src')) coverUrls.set(coverId.value, coverImage.getAttribute('src'));
  try {
    const stored = localStorage.getItem(coverKey);
    if (stored) {
      const saved = JSON.parse(stored);
      if (isStoredImage(saved.url)) coverUrls.set(saved.id, saved.url);
    }
  } catch {
    setCoverStatus('无法读取本地封面预览。已保存的服务器草稿仍可继续编辑。', true);
  }

  function renderCrop() {
    const x = cropX.value;
    const y = cropY.value;
    const zoom = cropZoom.value;
    coverImage.style.setProperty('object-position', `${x}% ${y}%`);
    coverImage.style.setProperty('transform-origin', `${x}% ${y}%`);
    coverImage.style.setProperty('transform', `scale(${zoom})`);
    for (const control of [cropX, cropY, cropZoom]) {
      workFields.querySelector(`[data-crop-label="${control.name}"]`).textContent = control === cropZoom ? `${Number(control.value).toFixed(2)}×` : `${control.value}%`;
    }
    const url = coverUrls.get(coverId.value);
    coverImage.hidden = !url;
    placeholder.hidden = !!url;
    coverReset.hidden = !url;
    if (url && coverImage.getAttribute('src') !== url) coverImage.src = url;
  }

  function syncWorkFields() {
    const active = categorySelect.value === '4';
    workFields.hidden = !active;
    for (const control of workFields.querySelectorAll('input, textarea, select, button')) {
      control.disabled = !active || uploadingCover && control.matches('[data-cover-input], [data-cover-upload]');
    }
    renderCrop();
  }

  function resetCrop() {
    cropX.value = '50';
    cropY.value = '50';
    cropZoom.value = '1';
    renderCrop();
    cropX.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function uploadCover() {
    if (!selectedFile) {
      setCoverStatus('请先选择一张封面图片。', true);
      return;
    }
    coverRequest?.abort();
    const controller = new AbortController();
    coverRequest = controller;
    uploadingCover = true;
    failedCover = false;
    recovery.hidden = true;
    syncWorkFields();
    setCoverStatus(`正在上传 ${selectedFile.name}…`);
    const data = new FormData();
    data.set('csrf', workForm.querySelector('input[name="csrf"]').value);
    data.set('cover', selectedFile);
    try {
      const response = await fetch('/works/cover', { method: 'POST', body: data, headers: { Accept: 'application/json' }, signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '封面上传失败，请重试。');
      if (!isStoredImage(result.url)) throw new Error('封面地址不属于本站存储，无法使用这张图片。');
      if (coverRequest !== controller) return;
      coverId.value = result.id;
      coverUrls.set(result.id, result.url);
      coverInput.value = '';
      selectedFile = undefined;
      resetCrop();
      coverId.dispatchEvent(new Event('input', { bubbles: true }));
      setCoverStatus('封面已上传，调整取景后发布。');
      try {
        localStorage.setItem(coverKey, JSON.stringify({ id: result.id, url: result.url }));
      } catch {
        setCoverStatus('封面已上传，但浏览器无法保存本地预览，请使用“保存草稿”。', true);
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      failedCover = true;
      recovery.hidden = false;
      setCoverStatus(`封面上传未完成：${error.message}`, true);
    } finally {
      if (coverRequest === controller) {
        uploadingCover = false;
        syncWorkFields();
      }
    }
  }

  coverInput.addEventListener('change', () => {
    selectedFile = coverInput.files[0];
    if (selectedFile) uploadCover();
  });
  coverReset.addEventListener('click', resetCrop);
  retryCover.addEventListener('click', uploadCover);
  cancelCover.addEventListener('click', () => {
    coverRequest?.abort();
    uploadingCover = false;
    failedCover = false;
    selectedFile = undefined;
    coverInput.value = '';
    recovery.hidden = true;
    setCoverStatus(coverId.value ? '已保留原来的封面。' : '已取消上传，请选择封面后再发布。');
    syncWorkFields();
  });
  workForm.addEventListener('input', syncWorkFields);
  categorySelect.addEventListener('change', syncWorkFields);
  document.addEventListener('community:work-restored', syncWorkFields);
  workForm.addEventListener('submit', (event) => {
    if (event.submitter?.hasAttribute('data-cover-upload')) {
      event.preventDefault();
      selectedFile = coverInput.files[0] || selectedFile;
      uploadCover();
      return;
    }
    if (categorySelect.value === '4' && (uploadingCover || failedCover)) {
      event.preventDefault();
      setCoverStatus(uploadingCover ? '封面还在上传，请完成后再提交。' : '请重试封面上传，或取消这次上传后再提交。', true);
    }
  }, true);
  syncWorkFields();
}
