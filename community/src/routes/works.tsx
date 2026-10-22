import type { Hono } from 'hono';
import type { Env } from '../types.js';
import { WorksPage, WorkCard } from '../views/works.js';
import { Layout, Csrf } from '../views/layout.js';
import { pageProps } from '../views/forms.js';
import { Editor } from '../views/posts.js';
import { worksPage, getWork } from '../lib/works.js';
import { postInput, getPost } from '../lib/posts.js';
import { FormError } from '../lib/validation.js';
import { requireUser, requireStaff } from '../lib/session.js';
import { saveImage } from '../lib/images.js';
import { limit, logAdmin } from '../lib/auth.js';
import { notify } from '../lib/interactions.js';
export function workRoutes(app:Hono<Env>) {
  app.get('/admin/works',c=>{
    const user=requireStaff(c),db=c.get('db');
    const rows=db.prepare("SELECT w.post_id FROM works w JOIN posts p ON p.id=w.post_id JOIN users u ON u.id=p.author_id WHERE p.status!='deleted' AND u.banned=0 ORDER BY p.created_at DESC LIMIT 50").all() as {post_id:number}[];
    return c.html(<Layout {...pageProps(c,'管理作品精选')}><h1>作品精选</h1><a href="/admin">返回管理</a><div class="work-grid">{rows.map(row=>{const work=getWork(db,row.post_id,user)!;return <section><WorkCard work={work}/><form method="post" action={`/admin/works/${row.post_id}/select`}><Csrf value={c.get('csrf')}/><input type="hidden" name="active" value={work.selected_at?'0':'1'}/><button class="button">{work.selected_at?'取消精选':'设为精选'}</button></form></section>;})}</div></Layout>);
  });
  app.post('/admin/works/:id/select',async c=>{
    const user=requireStaff(c),db=c.get('db'),work=getWork(db,Number(c.req.param('id')),user);
    if(!work)throw new FormError('作品不存在',{},404);
    const active=String((await c.req.formData()).get('active'));
    if(!['0','1'].includes(active))throw new FormError('操作无效');
    db.transaction(()=>{db.prepare('UPDATE works SET selected_at=? WHERE post_id=?').run(active==='1'?c.get('now'):null,work.post.id);logAdmin(db,user.id,active==='1'?'work.select':'work.unselect',String(work.post.id),c.get('now'));if(active==='1'&&!work.selected_at)notify(db,work.post.author_id,user.id,'selected',work.post.id,0,c.get('now'));})();
    return c.redirect('/admin/works',303);
  });
  app.get('/works',c=>c.html(<WorksPage c={c} data={worksPage(c.get('db'),c.get('user'),{sort:c.req.query('sort')==='latest'?'latest':'votes',range:c.req.query('range')??'all',harness:c.req.query('harness')??'',cursor:c.req.query('cursor')},c.get('now'))}/>));
  app.post('/works/cover',async c=>{
    const user=requireUser(c),form=await c.req.formData(),values=postInput(form);
    let post;
    if(/^post-\d+$/.test(values.editorId)){post=getPost(c.get('db'),Number(values.editorId.slice(5)),user);if(post.author_id!==user.id&&user.role!=='admin')throw new FormError('不能编辑他人的作品',{},403);}
    try {
      limit(c.get('db'),'image-hour',String(user.id),60,3600000,c.get('now'));limit(c.get('db'),'image-day',String(user.id),200,86400000,c.get('now'));
      const file=form.get('cover');if(!(file instanceof File))throw new FormError('请选择封面图片',{cover:'请选择图片'});
      const image=await saveImage(c.get('db'),c.get('storage'),user.id,Buffer.from(await file.arrayBuffer()),c.get('now'));
      if(c.req.header('accept')?.includes('application/json'))return c.json(image);
      values.category='4';values.work.coverId=image.id;values.work.cropX='50';values.work.cropY='50';values.work.cropZoom='1';
      return c.html(<Editor c={c} values={values} post={post} notice="封面已上传，调整裁剪位置后发布。"/>);
    } catch(error) {if(!(error instanceof FormError))throw error;if(c.req.header('accept')?.includes('application/json'))throw error;return c.html(<Editor c={c} values={values} post={post} error={error}/>,error.status);}
  });
}
