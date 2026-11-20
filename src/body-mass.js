// Adult reference categories: https://www.cdc.gov/bmi/adult-calculator/bmi-categories.html
export function bodyMass(client,today=new Date().toISOString().slice(0,10)){
  const {height,weight}=client.training||{};
  if(!Number.isFinite(height)||!Number.isFinite(weight)||height<=0||weight<=0)return null;
  const value=weight/(height/100)**2;
  const birthday=client.profile?.birthday;
  const age=/^\d{4}-\d{2}-\d{2}$/.test(birthday||'')?Number(today.slice(0,4))-Number(birthday.slice(0,4))-(today.slice(5)<birthday.slice(5)?1:0):null;
  if(age===null||age<20)return {value,label:age===null?'Для оценки нужен год рождения':'Для этого возраста нужна возрастная шкала',tone:'muted',adult:false};
  return {value,adult:true,...(value<18.5?{label:'Ниже обычного диапазона',tone:'attention'}:value<25?{label:'В обычном диапазоне',tone:'normal'}:value<30?{label:'Выше обычного диапазона',tone:'attention'}:{label:'Значительно выше обычного диапазона',tone:'attention'})};
}
