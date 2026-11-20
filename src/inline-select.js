// Compact, keyboard-accessible chooser styled like the race season menu.
export function inlineSelect(document,options,value,label){
  const element=document.createElement('details');element.className='catalog-control inline-select';
  const summary=document.createElement('summary'),list=document.createElement('div');
  summary.setAttribute('role','button');summary.setAttribute('aria-haspopup','listbox');
  list.className='catalog-control-options inline-select-options';list.setAttribute('role','listbox');list.setAttribute('aria-label',label);
  let selected=options.some(([key])=>key===value)?value:options[0][0];
  const buttons=[];
  const close=()=>{element.open=false;summary.focus();};
  function update(){
    summary.textContent=options.find(([key])=>key===selected)[1];summary.setAttribute('aria-label',label+': '+summary.textContent);
    buttons.forEach((button,index)=>{button.setAttribute('aria-selected',String(options[index][0]===selected));button.tabIndex=options[index][0]===selected?0:-1;});
  }
  for(const [key,title] of options){
    const button=document.createElement('button');button.type='button';button.textContent=title;button.setAttribute('role','option');
    button.addEventListener('click',()=>{selected=key;update();close();element.dispatchEvent(new Event('change',{bubbles:true}));});
    buttons.push(button);list.append(button);
  }
  element.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&element.open){event.preventDefault();event.stopPropagation();close();return;}
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      event.preventDefault();const opened=element.open;element.open=true;
      const current=buttons.indexOf(document.activeElement),chosen=options.findIndex(([key])=>key===selected);
      const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:!opened||current<0?chosen:
        (current+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length;
      buttons[next].focus();
    }
  });
  element.addEventListener('focusout',event=>{if(event.relatedTarget&&!element.contains(event.relatedTarget))element.open=false;});
  element.append(summary,list);update();
  const field=document.createElement('div');field.className='inline-select-field';
  const caption=document.createElement('span');caption.textContent=label;field.append(caption,element);
  return {element,field,get value(){return selected;}};
}
