const normalized=value=>value.trim().replace(/\s+/g,' ');

// Ignore keyboard finalization events unless the query actually changed.
// Each request owns a generation so an old response cannot restore stale choices.
export function createRecipientSearch({search,onChange}){
  let query='',generation=0;
  let state={contacts:[],selected:null,busy:false,error:'',searched:false};
  const publish=()=>onChange({...state});
  function reset(){generation++;state={contacts:[],selected:null,busy:false,error:'',searched:false};publish();}
  return {
    setQuery(value){const next=normalized(value);if(next===query)return;query=next;reset();},
    async find(){
      const request=++generation;
      state={contacts:[],selected:null,busy:true,error:'',searched:true};publish();
      try{
        if(query.length<2||query.length>120)throw Error('Введи имя из Telegram или @username');
        const result=await search(query);
        if(request!==generation)return;
        if(!Array.isArray(result.contacts)||result.contacts.length>10)throw Error('Не удалось проверить список контактов');
        const contacts=result.contacts.map(contact=>{
          if(!/^[1-9][0-9]{0,18}$/.test(contact.peerId)||typeof contact.displayName!=='string'||!contact.displayName.trim()||(contact.username!==null&&contact.username!==undefined&&typeof contact.username!=='string'))throw Error('Некорректный получатель');
          return {peerId:contact.peerId,displayName:contact.displayName,username:contact.username||null};
        });
        state={contacts:[...new Map(contacts.map(c=>[c.peerId,c])).values()],selected:null,busy:false,error:'',searched:true};
      }catch(error){if(request!==generation)return;state={contacts:[],selected:null,busy:false,error:error.message,searched:true};}
      publish();
    },
    select(peerId){const contact=state.contacts.find(c=>c.peerId===peerId);if(!contact||state.busy)return;state={...state,selected:contact};publish();},
    selected(){return state.selected;},
    dispose(){generation++;}
  };
}
