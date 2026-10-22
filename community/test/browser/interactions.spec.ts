import { test, expect } from '@playwright/test';
test('R-1 R-2 R-3 R-4 楼层引用、150楼直达、跳转与即时点赞',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/login');await page.getByLabel('用户名',{exact:true}).fill('浏览器管理员');await page.getByLabel('密码',{exact:true}).fill('browser-test-password');await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.goto('/p/1#150');
  await expect(page.locator('[data-floor="150"]')).toBeInViewport();
  expect(await page.locator('#reply-pages > [data-floor]').count()).toBeLessThan(200);
  await page.locator('[data-floor="150"] .prose').evaluate(element=>{
    const range=document.createRange();range.selectNodeContents(element);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));
  });
  await page.locator('#reply-quote').click();
  await expect(page.locator('#reply-form textarea')).toHaveValue(/> 这是第 150 楼的一段文字。/);
  await expect(page.locator('#reply-form textarea')).toHaveValue(/\/p\/1#150/);
  await page.locator('#reply-form textarea').fill('引用后的讨论，@图片');
  await expect(page.getByRole('option').filter({hasText:'图片同学'})).toBeVisible();
  await page.getByRole('option').filter({hasText:'图片同学'}).click();
  await expect(page.locator('#reply-form textarea')).toHaveValue(/@图片同学/);
  await page.getByRole('button',{name:'发布回复',exact:true}).click();
  await expect(page.locator('[data-floor="201"]')).toContainText('回复 #150');
  await page.getByRole('button',{name:'点赞',exact:true}).click();
  await expect(page.getByRole('button',{name:'取消点赞',exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});
