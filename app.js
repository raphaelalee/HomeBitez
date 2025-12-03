const express = require('express');
const app = express();

app.get('/', (req, res) => {
   res.send("Hello World!")
})

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));


//hi 


//bye

//hello raphaela 
//hello marla
// test push from Raphaela

