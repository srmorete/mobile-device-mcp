package dev.uitreeserver

object WebViewConstants {

    val ROLE_CLASS_MAP = mapOf(
        "button" to "webview.Button",
        "link" to "webview.Link",
        "textbox" to "webview.Input",
        "searchbox" to "webview.Input",
        "spinbutton" to "webview.Input",
        "combobox" to "webview.Select",
        "listbox" to "webview.Select",
        "checkbox" to "webview.Checkbox",
        "radio" to "webview.Radio",
        "switch" to "webview.Switch",
        "slider" to "webview.Slider",
        "menuitem" to "webview.MenuItem",
        "menuitemcheckbox" to "webview.MenuItem",
        "menuitemradio" to "webview.MenuItem",
        "heading" to "webview.Heading",
        "paragraph" to "webview.Paragraph",
        "list" to "webview.List",
        "listitem" to "webview.ListItem",
        "table" to "webview.Table",
        "row" to "webview.TableRow",
        "cell" to "webview.TableCell",
        "gridcell" to "webview.TableCell",
        "columnheader" to "webview.TableCell",
        "rowheader" to "webview.TableCell",
        "navigation" to "webview.Navigation",
        "main" to "webview.Main",
        "article" to "webview.Article",
        "banner" to "webview.Banner",
        "contentinfo" to "webview.Footer",
        "complementary" to "webview.Aside",
        "region" to "webview.Section",
        "section" to "webview.Section",
        "form" to "webview.Form",
        "dialog" to "webview.Dialog",
        "alertdialog" to "webview.Dialog",
        "img" to "webview.Image",
        "image" to "webview.Image"
    )

    val CLICKABLE_ROLES = setOf(
        "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
        "checkbox", "radio", "switch", "tab", "treeitem", "option"
    )

    val EXTRACT_SCRIPT = """
(()=>{
const dpr=window.devicePixelRatio||1;
const TR={
  A:'link',BUTTON:'button',INPUT:'textbox',TEXTAREA:'textbox',SELECT:'combobox',
  NAV:'navigation',MAIN:'main',H1:'heading',H2:'heading',H3:'heading',
  H4:'heading',H5:'heading',H6:'heading',IMG:'img',TABLE:'table',
  FORM:'form',UL:'list',OL:'list',LI:'listitem',TR:'row',TD:'cell',
  TH:'columnheader',ARTICLE:'article',ASIDE:'complementary',
  FOOTER:'contentinfo',HEADER:'banner',SECTION:'region',
  DIALOG:'dialog',P:'paragraph',FIGCAPTION:'paragraph',
  OPTION:'option',PROGRESS:'progressbar',METER:'meter',
  DETAILS:'group',SUMMARY:'button',FIELDSET:'group'
};
const TEXT_ROLES=new Set([
  'link','button','heading','paragraph','listitem','cell','columnheader',
  'rowheader','tab','treeitem','option','menuitem','menuitemcheckbox',
  'menuitemradio','img','progressbar','meter'
]);
const res=[];
if(!document.body)return JSON.stringify(res);
const all=document.body.querySelectorAll('*');
for(let i=0;i<all.length;i++){
  const el=all[i];
  const st=getComputedStyle(el);
  if(st.display==='none'||st.visibility==='hidden')continue;
  if(el.getAttribute('aria-hidden')==='true')continue;
  const rc=el.getBoundingClientRect();
  if(rc.width<=0||rc.height<=0)continue;
  let role=el.getAttribute('role')||TR[el.tagName]||'';
  if(el.tagName==='INPUT'){
    const t=el.type;
    if(t==='checkbox')role='checkbox';
    else if(t==='radio')role='radio';
    else if(t==='range')role='slider';
    else if(t==='number')role='spinbutton';
    else if(t==='search')role='searchbox';
    else if(t==='submit'||t==='button'||t==='reset')role='button';
  }
  if(!role)continue;
  let name='';
  const alb=el.getAttribute('aria-labelledby');
  const al=el.getAttribute('aria-label');
  if(alb){
    name=alb.split(/\s+/).map(id=>{
      const r=document.getElementById(id);
      return r?r.textContent.trim():''
    }).filter(Boolean).join(' ');
  }else if(al){
    name=al;
  }else if(el.tagName==='IMG'){
    name=el.alt||'';
  }else if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'){
    name=el.value||el.placeholder||'';
  }else if(TEXT_ROLES.has(role)){
    name=(el.textContent||'').trim().substring(0,500);
  }
  const rawDesc=el.title||el.getAttribute('aria-description')||'';
  const desc=typeof rawDesc==='string'?rawDesc:'';
  const e={
    r:role,n:typeof name==='string'?name:'',
    l:Math.round(rc.left*dpr),t:Math.round(rc.top*dpr),
    ri:Math.round(rc.right*dpr),b:Math.round(rc.bottom*dpr)
  };
  if(desc)e.d=desc;
  if(el.disabled===true||el.getAttribute('aria-disabled')==='true')e.di=true;
  if(el.checked===true)e.ch=true;
  const ck=el.type==='checkbox'||el.type==='radio'||role==='checkbox'||role==='radio'||role==='switch';
  if(ck)e.ca=true;
  if(document.activeElement===el)e.fo=true;
  if(el.selected===true||el.getAttribute('aria-selected')==='true')e.se=true;
  if(el.tagName==='INPUT'&&el.type==='password')e.pw=true;
  res.push(e);
}
return JSON.stringify(res);
})()
    """.trimIndent()
}
